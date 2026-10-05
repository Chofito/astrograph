import { beforeAll, describe, expect, test } from "bun:test";
import { extract } from "../src/core/extract";
import type { Extraction } from "../src/core/extract/types";
import { initParsers } from "../src/core/parser";

beforeAll(() => initParsers());

const symbols = (x: Extraction) => x.symbols.map((s) => `${s.kind} ${s.qualifiedName}`);
const refs = (x: Extraction) =>
	x.refs.map((r) => {
		const from = r.from === null ? "<file>" : x.symbols[r.from]?.qualifiedName;
		const target = r.receiver ? `${r.receiver}.${r.name}` : r.name;
		return `${from} ${r.kind} ${target}${r.hints ? ` [${r.hints.join(" | ")}]` : ""}`;
	});

describe("typescript", () => {
	test("declarations: top level and class members only", () => {
		const x = extract(
			"typescript",
			`export class Service extends Base implements Port {
				private count = 0;
				handler = () => this.run();
				run(): void { const local = 1; function inner() {} }
			}
			export const make = () => new Service();
			interface Port { run(): void }
			type Id = string;
			enum Color { Red }
			describe("x", () => { const notASymbol = 1; });`,
		);
		expect(symbols(x)).toEqual([
			"class Service",
			"property Service.count",
			"method Service.handler",
			"method Service.run",
			"function make",
			"interface Port",
			"method Port.run",
			"type Id",
			"enum Color",
		]);
		expect(x.symbols.find((s) => s.name === "Service")?.exported).toBe(true);
		expect(x.symbols.find((s) => s.name === "Port")?.exported).toBe(false);
	});

	test("references: calls, new, inheritance, JSX", () => {
		const x = extract(
			"tsx",
			`class A extends B implements C { m() { this.n(); helper(); ns.fn(); } }
			function View() { return <Layout><Item.Row /><div /></Layout>; }`,
		);
		expect(refs(x)).toEqual([
			"A extends B",
			"A implements C",
			"A.m call this.n",
			"A.m call helper",
			"A.m call ns.fn",
			"View render Layout",
			"View render Item.Row",
		]);
	});

	test("receiver types from annotations, new, fields, parameter properties and return types", () => {
		const x = extract(
			"typescript",
			`class Ctl {
				private repo: Repo;
				constructor(private readonly mailer: Mailer) {}
				async handle(input: Input) {
					const user = new User();
					const conn = await connect();
					user.save(); input.check(); this.repo.find(); this.mailer.send(); conn.query();
				}
			}`,
		);
		const hinted = refs(x).filter((r) => r.includes("["));
		expect(hinted).toEqual([
			"Ctl.handle call user.save [User]",
			"Ctl.handle call input.check [Input]",
			"Ctl.handle call this.repo.find [Repo]",
			"Ctl.handle call this.mailer.send [Mailer]",
			"Ctl.handle call conn.query [()connect]",
		]);
	});

	test("complex receivers are marked unknown, not bare calls", () => {
		const x = extract("typescript", "export function f() { items().filter(Boolean); }");
		expect(refs(x)).toContain("f call ?.filter");
	});

	test("imports, require and re-exports", () => {
		const x = extract(
			"typescript",
			`import Def, { a as b } from "./x";
			import * as ns from "pkg";
			const { c } = require("./c");
			export { b as bb };
			export * from "./all";
			export { d } from "./d";
			export default function main() {}`,
		);
		expect(x.imports).toEqual([
			{ local: "Def", imported: "default", source: "./x", reexport: false },
			{ local: "b", imported: "a", source: "./x", reexport: false },
			{ local: "ns", imported: "*", source: "pkg", reexport: false },
			{ local: "c", imported: "c", source: "./c", reexport: false },
			{ local: "bb", imported: "b", source: null, reexport: true },
			{ local: "*", imported: "*", source: "./all", reexport: true },
			{ local: "d", imported: "d", source: "./d", reexport: true },
			{ local: "default", imported: "main", source: null, reexport: true },
		]);
	});
});

describe("php", () => {
	test("fully qualified declarations", () => {
		const x = extract(
			"php",
			`<?php
			namespace App\\Http;
			class Ctl extends Base { private $x; const K = 1; public function show() {} }
			interface Port {}
			trait Helps {}
			function helper() {}`,
		);
		expect(symbols(x)).toEqual([
			"class App\\Http\\Ctl",
			"property App\\Http\\Ctl::$x",
			"constant App\\Http\\Ctl::K",
			"method App\\Http\\Ctl::show",
			"interface App\\Http\\Port",
			"trait App\\Http\\Helps",
			"function App\\Http\\helper",
		]);
	});

	test("call targets resolved through namespace and use imports", () => {
		const x = extract(
			"php",
			`<?php
			namespace App;
			use App\\Models\\User;
			use App\\Svc\\{Mailer, Log as L};
			use function App\\fmt\\money;
			class Ctl extends Base {
				use Traits\\Helps;
				function go() { User::find(1); new Mailer(); L::info(); money(); strlen("x"); \\trim(""); parent::go(); $this->x(); }
			}`,
		);
		expect(refs(x)).toEqual([
			"App\\Ctl extends Base [App\\Base]",
			"App\\Ctl extends Helps [App\\Traits\\Helps]",
			"App\\Ctl::go call App\\Models\\User.find [App\\Models\\User::find]",
			"App\\Ctl::go new Mailer [App\\Svc\\Mailer]",
			"App\\Ctl::go call App\\Svc\\Log.info [App\\Svc\\Log::info]",
			"App\\Ctl::go call money [App\\fmt\\money]",
			"App\\Ctl::go call strlen [App\\strlen | strlen]",
			"App\\Ctl::go call trim [trim]",
			"App\\Ctl::go call parent.go",
			"App\\Ctl::go call this.x",
		]);
	});

	test("receiver types from typed params, properties, DI assignments, promotion, new and catch", () => {
		const x = extract(
			"php",
			`<?php
			namespace App;
			use Psr\\Log\\LoggerInterface;
			class Job {
				/** @var Helper */
				protected $helper;
				private Repo $repo;
				public function __construct(LoggerInterface $logger, private Mailer $mailer, Helper $helper) {
					$this->logger = $logger;
					$this->helper = $helper;
				}
				function run(Input $in) {
					$w = new Worker();
					try { $w->go(); } catch (\\RuntimeException $e) { $e->getMessage(); }
					$in->check(); $this->repo->find(); $this->mailer->send(); $this->logger->info(""); $this->helper->help();
				}
			}`,
		);
		const hinted = refs(x)
			.filter((r) => r.includes(" call ") && r.includes("["))
			.map((r) => r.slice(r.indexOf("[")));
		expect(hinted).toEqual([
			"[App\\Worker::go]",
			"[RuntimeException::getMessage]",
			"[App\\Input::check]",
			"[App\\Repo::find]",
			"[App\\Mailer::send]",
			"[Psr\\Log\\LoggerInterface::info]",
			"[App\\Helper::help]",
		]);
	});
});
