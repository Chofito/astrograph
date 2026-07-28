import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BunGlobScanner } from "./glob";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true });
	}
	tempRoots.length = 0;
});

describe("BunGlobScanner", () => {
	test("finds JS/TS files, honors ignores and yields sorted relative paths", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, ".gitignore", "ignored.ts\nignored-dir/\n");
		await writeProjectFile(root, "src/b.jsx", "export const b = 1;");
		await writeProjectFile(root, "src/a.ts", "export const a = 1;");
		await writeProjectFile(root, "src/c.mts", "export const c = 1;");
		await writeProjectFile(root, "src/readme.md", "# ignored");
		await writeProjectFile(root, "ignored.ts", "export const ignored = 1;");
		await writeProjectFile(
			root,
			"ignored-dir/also.ts",
			"export const ignored = 1;",
		);
		await writeProjectFile(root, "excluded/skip.ts", "export const skip = 1;");
		await writeProjectFile(
			root,
			"node_modules/pkg/index.ts",
			"export const pkg = 1;",
		);
		await writeProjectFile(
			root,
			".astrograph/cache.ts",
			"export const cache = 1;",
		);
		await writeProjectFile(root, "dist/out.ts", "export const out = 1;");

		const scanner = new BunGlobScanner();
		const files: string[] = [];
		for await (const relPath of scanner.scan(root, {
			exclude: ["excluded/**"],
		})) {
			files.push(relPath);
		}

		expect(files).toEqual(["src/a.ts", "src/b.jsx", "src/c.mts"]);
	});

	test("always excludes build dirs and yarn/pnpm committed artifacts", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/a.ts", "export const a = 1;");
		await writeProjectFile(root, "build/b.ts", "export const b = 1;");
		await writeProjectFile(root, "out/o.ts", "export const o = 1;");
		await writeProjectFile(root, "output/p.ts", "export const p = 1;");
		await writeProjectFile(root, ".next/n.js", "export const n = 1;");
		await writeProjectFile(root, ".pnp.cjs", "module.exports = {};");
		await writeProjectFile(
			root,
			".yarn/releases/yarn-4.0.0.cjs",
			"module.exports = {};",
		);

		const scanner = new BunGlobScanner();
		const files: string[] = [];
		for await (const relPath of scanner.scan(root, {})) {
			files.push(relPath);
		}

		expect(files).toEqual(["src/a.ts"]);
	});

	test("finds .php files when constructed with the php extension", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/a.ts", "export const a = 1;");
		await writeProjectFile(
			root,
			"src/Greeter.php",
			"<?php\nclass Greeter {}\n",
		);

		const scanner = new BunGlobScanner({ extensions: [".ts", ".php"] });
		const files: string[] = [];
		for await (const relPath of scanner.scan(root, {})) {
			files.push(relPath);
		}

		expect(files).toEqual(["src/Greeter.php", "src/a.ts"]);
	});

	test("honors the extension list it was constructed with, ignoring extensions outside it", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, "src/a.php", "<?php\n");
		await writeProjectFile(root, "src/b.ts", "export const b = 1;");
		await writeProjectFile(root, "src/c.jsx", "export const c = 1;");

		const phpOnly = new BunGlobScanner({ extensions: [".php"] });
		const phpFiles: string[] = [];
		for await (const relPath of phpOnly.scan(root, {})) {
			phpFiles.push(relPath);
		}
		expect(phpFiles).toEqual(["src/a.php"]);

		const tsOnly = new BunGlobScanner({ extensions: [".ts"] });
		const tsFiles: string[] = [];
		for await (const relPath of tsOnly.scan(root, {})) {
			tsFiles.push(relPath);
		}
		expect(tsFiles).toEqual(["src/b.ts"]);
	});

	test("git-tracked files survive a Magento-style whitelist .gitignore (`*`)", async () => {
		const root = await makeTempProject();
		await writeProjectFile(root, ".gitignore", "*\n");
		await writeProjectFile(
			root,
			"app/code/Vendor/Module/registration.php",
			"<?php\n",
		);
		await writeProjectFile(root, "src/whitelisted.ts", "export const ok = 1;");

		await git(root, ["init"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Test"]);
		// Force-add: `*` would otherwise leave the working tree untracked.
		await git(root, ["add", "-f", "app/code/Vendor/Module/registration.php"]);
		await git(root, ["commit", "-m", "track custom module"]);

		const scanner = new BunGlobScanner({ extensions: [".ts", ".php"] });
		const files: string[] = [];
		for await (const relPath of scanner.scan(root, {})) {
			files.push(relPath);
		}

		expect(files).toContain("app/code/Vendor/Module/registration.php");
		// Untracked paths under `*` stay ignored.
		expect(files).not.toContain("src/whitelisted.ts");
	});
});

async function git(root: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exit = await proc.exited;
	if (exit !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${err}`);
	}
}

async function makeTempProject(): Promise<string> {
	const root = await mkdtemp(`${tmpdir()}/astrograph-glob-`);
	tempRoots.push(root);
	return root;
}

async function writeProjectFile(
	root: string,
	relPath: string,
	content: string,
): Promise<void> {
	const fullPath = `${root}/${relPath}`;
	const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await writeFile(fullPath, content, "utf8");
}
