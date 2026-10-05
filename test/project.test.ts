import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Project } from "../src/core";
import { estimateTokens, formatFooter } from "../src/format";
import { type Args, getTool } from "../src/tools";

/** A small mixed repo exercising every resolution route the linker supports. */
const FILES: Record<string, string> = {
	"tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }`,
	"src/lib/db.ts": `
		export class Database {
			query(sql: string) { return sql; }
		}
		export function openDatabase(): Database { return new Database(); }`,
	"src/lib/index.ts": `export * from "./db";\nexport { format as fmt } from "./format";`,
	"src/lib/format.ts": `export function format(v: string) { return v.trim(); }`,
	"src/repo.ts": `
		import { Database, fmt } from "./lib";
		import { openDatabase } from "@lib/db";
		export class BaseRepo {
			constructor(protected readonly db: Database) {}
			log(msg: string) { return fmt(msg); }
		}
		export class UserRepo extends BaseRepo {
			find(id: string) {
				this.log(id);
				return this.db.query(id);
			}
		}
		export function makeRepo(): UserRepo {
			const db = openDatabase();
			db.query("warmup");
			return new UserRepo(db);
		}`,
	"src/app.tsx": `
		import { makeRepo } from "./repo";
		export function App() { return <Profile id="1" />; }
		function Profile(props: { id: string }) {
			const repo = makeRepo();
			return <div>{repo.find(props.id)}</div>;
		}`,
	"php/Models/User.php": `<?php
		namespace App\\Models;
		class User extends Model {
			public static function findByEmail(string $email): ?self { return static::where($email); }
			public function save(): bool { return true; }
		}`,
	"php/Services/Signup.php": `<?php
		namespace App\\Services;
		use App\\Models\\User;
		use Psr\\Log\\LoggerInterface;
		class Signup {
			public function __construct(private LoggerInterface $logger, private Mailer $mailer) {}
			public function register(string $email): User {
				$found = User::findByEmail($email);
				$user = new User();
				$user->save();
				$this->mailer->welcome($user);
				$this->logger->info("registered");
				return $user;
			}
		}`,
	"php/Services/Mailer.php": `<?php
		namespace App\\Services;
		class Mailer { public function welcome($user): void { helper(); } }
		function helper() {}`,
	"node_modules/dep/index.js": "export function ignored() {}",
};

let root: string;
let project: Project;

const write = (path: string, content: string) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
};

const callerNames = (symbol: string) => {
	const target = project.graph.lookup(symbol).symbol;
	if (!target) throw new Error(`no symbol ${symbol}`);
	return project.graph.callers(target).map((e) => `${e.symbol?.qualifiedName ?? "<file>"}:${e.resolution}`);
};

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "astrograph-test-"));
	for (const [path, content] of Object.entries(FILES)) write(path, content);
	project = Project.open(root, { create: true });
	await project.sync();
});

afterAll(() => {
	project.close();
	rmSync(root, { recursive: true, force: true });
});

describe("indexing", () => {
	test("indexes source files and skips default excludes", () => {
		const paths = project.graph.files().map((f) => f.path);
		expect(paths).toContain("src/repo.ts");
		expect(paths).toContain("php/Models/User.php");
		expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
	});

	test("a second sync with no changes does nothing", async () => {
		const result = await project.sync();
		expect(result.added + result.modified + result.removed).toBe(0);
	});
});

describe("JS/TS resolution", () => {
	test("barrel re-exports and aliased re-exports", () => {
		expect(callerNames("format")).toEqual(["BaseRepo.log:exact"]);
	});

	test("tsconfig paths", () => {
		expect(callerNames("openDatabase")).toEqual(["makeRepo:exact"]);
	});

	test("this-calls walk the parent class chain", () => {
		expect(callerNames("BaseRepo.log")).toEqual(["UserRepo.find:exact"]);
	});

	test("typed parameter properties, return types and new", () => {
		expect(callerNames("Database.query").sort()).toEqual(["UserRepo.find:exact", "makeRepo:exact"]);
		expect(callerNames("UserRepo.find")).toEqual(["Profile:exact"]);
		expect(callerNames("UserRepo")).toEqual(["makeRepo:exact"]);
	});

	test("JSX renders are references", () => {
		expect(callerNames("Profile")).toEqual(["App:exact"]);
	});
});

describe("PHP resolution", () => {
	test("static calls and new through use imports", () => {
		expect(callerNames("App\\Models\\User::findByEmail")).toEqual(["App\\Services\\Signup::register:exact"]);
		expect(callerNames("App\\Models\\User")).toEqual(["App\\Services\\Signup::register:exact"]);
	});

	test("typed locals and promoted properties", () => {
		expect(callerNames("App\\Models\\User::save")).toEqual(["App\\Services\\Signup::register:exact"]);
		expect(callerNames("Mailer::welcome")).toEqual(["App\\Services\\Signup::register:exact"]);
	});

	test("namespaced function falls back correctly", () => {
		expect(callerNames("App\\Services\\helper")).toEqual(["App\\Services\\Mailer::welcome:exact"]);
	});

	test("calls into libraries are external, not guesses", () => {
		const register = project.graph.lookup("Signup::register").symbol;
		if (!register) throw new Error("missing register");
		const external = project.graph
			.callees(register, { includeExternal: true })
			.filter((e) => e.resolution === "external")
			.map((e) => e.name);
		expect(external).toContain("info");
	});
});

describe("queries", () => {
	test("impact includes transitive dependents", () => {
		const query = project.graph.lookup("Database.query").symbol;
		if (!query) throw new Error("missing query");
		const names = project.graph.impact(query, 3).map((e) => e.symbol.qualifiedName);
		expect(names).toContain("UserRepo.find");
		expect(names).toContain("Profile");
		expect(names).toContain("App");
	});

	test("trace finds the call path", () => {
		const from = project.graph.lookup("App").symbol;
		const to = project.graph.lookup("Database.query").symbol;
		if (!from || !to) throw new Error("missing symbols");
		const path = project.graph.trace(from, to)?.map((s) => s.symbol.qualifiedName);
		expect(path?.[0]).toBe("App");
		expect(path?.at(-1)).toBe("Database.query");
	});

	test("lookup accepts path:name and #id", () => {
		const byPath = project.graph.lookup("src/lib/db.ts:Database").symbol;
		expect(byPath?.kind).toBe("class");
		expect(project.graph.lookup(`#${byPath?.id}`).symbol?.id).toBe(byPath?.id);
	});

	test("tools render text, including not-found hints", () => {
		const callers = getTool("callers");
		expect(callers?.run(project.graph, { symbol: "openDatabase" })).toContain("makeRepo");
		expect(callers?.run(project.graph, { symbol: "nopeNothing" })).toContain('No symbol matches "nopeNothing"');
		const context = getTool("context")?.run(project.graph, { task: "how does UserRepo find users" });
		expect(context).toContain("UserRepo.find");
	});
});

const run = (tool: string, args: Args) => {
	const t = getTool(tool);
	if (!t) throw new Error(`no tool ${tool}`);
	return t.run(project.graph, args);
};

describe("outline", () => {
	test("a file: signatures and line ranges, members nested, no bodies", () => {
		const text = run("outline", { target: "src/lib/db.ts" });
		expect(text).toContain("src/lib/db.ts");
		expect(text).toMatch(/class\s+export class Database/);
		expect(text).toMatch(/\n {4}\d+\s+method\s+query\(sql: string\)/);
		expect(text).not.toContain("return sql");
	});

	test("a unique path suffix resolves to the file", () => {
		expect(run("outline", { target: "repo.ts" })).toContain("src/repo.ts");
	});

	test("a directory lists top-level symbols of every file under it", () => {
		const text = run("outline", { target: "src/lib" });
		expect(text).toContain("3 files under");
		expect(text).toContain("function  export function format");
		expect(text).toContain("members hidden");
	});

	test("a class outlines its members", () => {
		const text = run("outline", { target: "UserRepo" });
		expect(text).toContain("method    find(id: string)");
	});
});

describe("budgets", () => {
	test("lists say what was cut and how to continue", () => {
		const text = run("callers", { symbol: "Database.query", limit: 1 });
		expect(text).toContain("… 1 more (showing 1–1 of 2); continue with offset=1");
		const second = run("callers", { symbol: "Database.query", limit: 1, offset: 1 });
		expect(second).toContain("makeRepo");
		expect(second).not.toContain("more");
	});

	test("answers stay near their maxTokens", () => {
		for (const [tool, args] of [
			["context", { task: "repo database query users" }],
			["explore", { query: "UserRepo Database makeRepo" }],
			["outline", { target: "src" }],
		] as const) {
			const text = run(tool, { ...args, maxTokens: 150 });
			expect(estimateTokens(text)).toBeLessThan(150 * 1.5);
		}
	});

	test("source is line-numbered and a cut says which lines are missing", () => {
		const full = run("node", { symbol: "UserRepo", includeCode: true });
		expect(full).toMatch(/\n\s*\d+│ {2}find\(id: string\)|\n\s*\d+│\s+find\(id: string\)/);
		const cut = run("node", { symbol: "UserRepo", includeCode: true, maxTokens: 90 });
		expect(cut).toMatch(/… lines \d+-\d+ not shown \(budget\)/);
	});

	test("the MCP footer reports the answer's token cost", () => {
		const footer = formatFooter("x".repeat(4000), project.graph.status());
		expect(footer).toContain("≈1.0k tokens");
		expect(footer).toContain("files indexed");
	});
});

describe("incremental sync", () => {
	test("new, changed and deleted files update the graph", async () => {
		write("src/extra.ts", `import { format } from "./lib/format";\nexport const shout = (v: string) => format(v);`);
		let result = await project.sync();
		expect(result.added).toBe(1);
		expect(callerNames("format").sort()).toEqual(["BaseRepo.log:exact", "shout:exact"]);

		write("src/extra.ts", "export const shout = (v: string) => v;");
		result = await project.sync();
		expect(result.modified).toBe(1);
		expect(callerNames("format")).toEqual(["BaseRepo.log:exact"]);

		unlinkSync(join(root, "src/extra.ts"));
		result = await project.sync();
		expect(result.removed).toBe(1);
		expect(project.graph.lookup("shout").symbol).toBeUndefined();
	});
});
