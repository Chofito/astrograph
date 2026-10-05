import type { Database } from "bun:sqlite";
import { ModuleResolver } from "./resolve";

export type Resolution = "exact" | "inferred" | "ambiguous" | "external" | "unresolved";

interface SymbolRow {
	id: number;
	file_id: number;
	parent_id: number | null;
	name: string;
	qualified_name: string;
	kind: string;
	return_type: string | null;
}

interface RefRow {
	id: number;
	file_id: number;
	from_id: number | null;
	kind: string;
	name: string;
	receiver: string | null;
	hints: string | null;
}

interface ImportRow {
	file_id: number;
	local: string;
	imported: string;
	source: string | null;
	reexport: number;
	resolved_file_id: number | null;
}

type Outcome = { target: number | null; resolution: Resolution };
type ExportHit = number | "external" | undefined;

const CALLABLE = new Set(["function", "method", "class"]);
const TYPES = new Set(["class", "interface", "trait", "enum", "type"]);
const RENDERABLE = new Set(["function", "class", "constant", "variable"]);
const MEMBER_KINDS = new Set(["method", "property", "constant"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Runtime globals: calls on or to these leave the project. */
const GLOBALS = new Set(
	(
		"Array ArrayBuffer BigInt Boolean Buffer Bun DataView Date Error EvalError Function Intl JSON Map Math Number " +
		"Object Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError URIError " +
		"URL URLSearchParams Uint8Array Int32Array Float64Array WeakMap WeakRef WeakSet AbortController Blob FormData " +
		"Headers Request Response TextDecoder TextEncoder WebSocket Worker console process document window globalThis " +
		"navigator localStorage sessionStorage setTimeout clearTimeout setInterval clearInterval queueMicrotask " +
		"structuredClone fetch require module exports parseInt parseFloat isNaN isFinite encodeURIComponent " +
		"decodeURIComponent encodeURI decodeURI atob btoa alert describe it test expect beforeEach afterEach beforeAll " +
		"afterAll jest vi"
	).split(" "),
);

/**
 * Method names so common on built-ins that matching `x.name()` to the one
 * project method of that name would mostly be wrong.
 */
const BUILTIN_MEMBERS = new Set(
	(
		"map filter reduce forEach find findIndex some every push pop shift unshift slice splice concat join split " +
		"replace replaceAll includes indexOf startsWith endsWith keys values entries get set has delete add clear " +
		"then catch finally toString valueOf toJSON log error warn info debug apply call bind on off once emit " +
		"test match exec trim sort reverse resolve reject parse stringify assign next json text flat flatMap at fill"
	).split(" "),
);

/**
 * Resolves every reference to a symbol. Runs after any file change: it is a
 * linear pass over in-memory maps of symbols and imports, far cheaper than
 * keeping a compiler program alive.
 */
export function linkReferences(db: Database, root: string): void {
	const files = db.query<{ id: number; path: string; lang: string }, []>("SELECT id, path, lang FROM files").all();
	const fileIdByPath = new Map<string, number>();
	const pathById = new Map<number, string>();
	const phpFiles = new Set<number>();
	for (const f of files) {
		fileIdByPath.set(f.path, f.id);
		pathById.set(f.id, f.path);
		if (f.lang === "php") phpFiles.add(f.id);
	}

	resolveImports(db, root, fileIdByPath, pathById, phpFiles);
	const linker = new Linker(db, phpFiles);
	// Inheritance first: member lookup on `this`/`parent` walks the parent chain.
	linker.resolvePages("kind IN ('extends', 'implements')", true);
	linker.resolvePages("kind NOT IN ('extends', 'implements')", false);
}

function resolveImports(
	db: Database,
	root: string,
	fileIdByPath: Map<string, number>,
	pathById: Map<number, string>,
	phpFiles: Set<number>,
) {
	const jsPaths = new Set([...fileIdByPath].filter(([, id]) => !phpFiles.has(id)).map(([path]) => path));
	const resolver = new ModuleResolver(root, jsPaths);
	const rows = db
		.query<{ id: number; file_id: number; source: string }, []>(
			"SELECT id, file_id, source FROM imports WHERE source IS NOT NULL",
		)
		.all();
	const update = db.prepare("UPDATE imports SET resolved_file_id = ? WHERE id = ?");
	db.transaction(() => {
		for (const row of rows) {
			const from = pathById.get(row.file_id);
			const hit = from ? resolver.resolve(from, row.source) : undefined;
			update.run(hit ? (fileIdByPath.get(hit) ?? null) : null, row.id);
		}
	})();
}

class Linker {
	private readonly symbols = new Map<number, SymbolRow>();
	/** file → top-level name → symbol ids */
	private readonly topLevel = new Map<number, Map<string, number[]>>();
	/** class → member name → symbol id */
	private readonly members = new Map<number, Map<string, number>>();
	private readonly byName = new Map<string, number[]>();
	/** PHP: lowercased FQN → symbol ids */
	private readonly byFqn = new Map<string, number[]>();
	private readonly imports = new Map<number, Map<string, ImportRow>>();
	private readonly reexports = new Map<number, ImportRow[]>();
	private readonly parents = new Map<number, number[]>();
	/** class → has a parent we could not find (framework base class, etc.) */
	private readonly externalParent = new Set<number>();

	constructor(
		private readonly db: Database,
		private readonly phpFiles: Set<number>,
	) {
		for (const s of db
			.query<SymbolRow, []>("SELECT id, file_id, parent_id, name, qualified_name, kind, return_type FROM symbols")
			.all()) {
			this.symbols.set(s.id, s);
			push(this.byName, s.name, s.id);
			if (phpFiles.has(s.file_id)) push(this.byFqn, s.qualified_name.toLowerCase(), s.id);
			if (s.parent_id === null) {
				const names = mapFor(this.topLevel, s.file_id);
				push(names, s.name, s.id);
			} else {
				const names = mapFor(this.members, s.parent_id);
				if (!names.has(s.name)) names.set(s.name, s.id);
			}
		}
		for (const row of db.query<ImportRow, []>("SELECT * FROM imports").all()) {
			if (row.reexport) {
				const list = this.reexports.get(row.file_id) ?? [];
				list.push(row);
				this.reexports.set(row.file_id, list);
			} else {
				const names = mapFor(this.imports, row.file_id);
				names.set(row.local, row);
			}
		}
	}

	/** Resolves matching refs page by page, so memory stays flat on large repos. */
	resolvePages(where: string, heritage: boolean) {
		const page = this.db.prepare<RefRow, [number]>(
			`SELECT id, file_id, from_id, kind, name, receiver, hints FROM refs WHERE id > ? AND ${where} ORDER BY id LIMIT 5000`,
		);
		const update = this.db.prepare("UPDATE refs SET target_id = ?, resolution = ? WHERE id = ?");
		const parents: [number | null, Outcome][] = [];
		let after = 0;
		while (true) {
			const rows = page.all(after);
			if (rows.length === 0) break;
			this.db.transaction(() => {
				for (const ref of rows) {
					const outcome = this.phpFiles.has(ref.file_id) ? this.resolvePhp(ref) : this.resolveJs(ref);
					update.run(outcome.target, outcome.resolution, ref.id);
					if (heritage) parents.push([ref.from_id, outcome]);
				}
			})();
			after = (rows.at(-1) as RefRow).id;
		}
		for (const [from, outcome] of parents) this.recordParent(from, outcome);
	}

	private recordParent(from: number | null, outcome: Outcome) {
		if (from === null) return;
		if (outcome.target !== null) push(this.parents, from, outcome.target);
		else if (outcome.resolution === "external" || outcome.resolution === "unresolved") this.externalParent.add(from);
	}

	// ── JS / TS ────────────────────────────────────────────────────────────

	private resolveJs(ref: RefRow): Outcome {
		const kinds = kindsFor(ref.kind);
		const { receiver, name } = ref;

		// The extractor knew the receiver's declared type (`x: Foo`, `new Foo()`, typed field).
		if (ref.hints) {
			const typed = this.resolveTypeName(ref.file_id, ref.hints);
			if (typed === "external") return external();
			if (typed !== undefined) {
				const hit = this.member(typed, name);
				if (hit !== undefined) return exact(hit);
				if (this.hasExternalAncestor(typed)) return external();
			}
		}

		if (receiver === null) {
			const local = this.pick(this.topLevel.get(ref.file_id)?.get(name), kinds);
			if (local !== undefined) return exact(local);
			const binding = this.imports.get(ref.file_id)?.get(name);
			if (binding)
				return this.fromExport(this.importTarget(binding, binding.imported === "*" ? "default" : binding.imported));
			if (GLOBALS.has(name)) return external();
			// Without imports the file is a script: globals may live anywhere.
			if (!this.imports.has(ref.file_id)) return this.byNameFallback(name, kinds);
			return unresolved();
		}

		if (receiver === "this" || receiver === "super") {
			const cls = this.classOf(ref.from_id);
			if (cls !== undefined) {
				const hit = receiver === "this" ? this.member(cls, name) : this.parentMember(cls, name);
				if (hit !== undefined) return exact(hit);
				if (this.hasExternalAncestor(cls)) return external();
			}
			return this.memberFallback(name);
		}

		if (IDENTIFIER.test(receiver)) {
			const binding = this.imports.get(ref.file_id)?.get(receiver);
			if (binding) {
				if (binding.imported === "*") return this.fromExport(this.importTarget(binding, name));
				const owner = this.importTarget(binding, binding.imported);
				if (owner === "external") return external();
				if (owner !== undefined) {
					const hit = this.member(owner, name);
					if (hit !== undefined) return exact(hit);
				}
			}
			const localClass = this.pick(this.topLevel.get(ref.file_id)?.get(receiver), TYPES);
			if (localClass !== undefined) {
				const hit = this.member(localClass, name);
				if (hit !== undefined) return exact(hit);
			}
			if (!binding && localClass === undefined && GLOBALS.has(receiver)) return external();
		}
		return BUILTIN_MEMBERS.has(name) ? external() : this.memberFallback(name);
	}

	private resolveTypeName(fileId: number, typeName: string, depth = 0): ExportHit {
		if (typeName.startsWith("()")) {
			// `x = f()`: type x by f's declared return type, looked up in f's own file.
			const fn = this.resolveTypeName(fileId, typeName.slice(2), depth + 1);
			const s = typeof fn === "number" ? this.symbols.get(fn) : undefined;
			if (!s?.return_type || depth > 3) return undefined;
			return this.resolveTypeName(s.file_id, s.return_type, depth + 1);
		}
		const local = this.pick(this.topLevel.get(fileId)?.get(typeName));
		if (local !== undefined) return local;
		const binding = this.imports.get(fileId)?.get(typeName);
		if (binding) return this.importTarget(binding, binding.imported === "*" ? "default" : binding.imported);
		return undefined;
	}

	private importTarget(binding: ImportRow, name: string): ExportHit {
		if (binding.resolved_file_id === null) return "external";
		return this.resolveExport(binding.resolved_file_id, name, 0);
	}

	/** Follows re-export chains (barrel files) up to a fixed depth. */
	private resolveExport(fileId: number, name: string, depth: number): ExportHit {
		if (depth > 6) return undefined;
		const reexports = this.reexports.get(fileId) ?? [];
		for (const row of reexports) {
			if (row.local !== name) continue;
			if (row.source === null) return this.pick(this.topLevel.get(fileId)?.get(row.imported));
			if (row.resolved_file_id === null) return "external";
			return this.resolveExport(row.resolved_file_id, row.imported, depth + 1);
		}
		const direct = this.pick(this.topLevel.get(fileId)?.get(name));
		if (direct !== undefined) return direct;
		for (const row of reexports) {
			if (row.local !== "*" || row.resolved_file_id === null) continue;
			const hit = this.resolveExport(row.resolved_file_id, name, depth + 1);
			if (typeof hit === "number") return hit;
		}
		return undefined;
	}

	private fromExport(hit: ExportHit): Outcome {
		if (hit === "external") return external();
		return hit === undefined ? unresolved() : exact(hit);
	}

	// ── PHP ────────────────────────────────────────────────────────────────

	private resolvePhp(ref: RefRow): Outcome {
		const kinds = kindsFor(ref.kind);
		if (ref.hints) {
			for (const hint of ref.hints.split("\n")) {
				const sep = hint.indexOf("::");
				if (sep === -1) {
					const hit = this.pick(this.byFqn.get(hint.toLowerCase()), kinds);
					if (hit !== undefined) return exact(hit);
					continue;
				}
				const cls = this.pick(this.byFqn.get(hint.slice(0, sep).toLowerCase()), TYPES);
				if (cls === undefined) continue;
				const hit = this.member(cls, ref.name);
				if (hit !== undefined) return exact(hit);
				if (this.hasExternalAncestor(cls)) return external();
				return unresolved();
			}
			return external();
		}

		const receiver = ref.receiver;
		if (receiver === "this" || receiver === "self" || receiver === "static" || receiver === "parent") {
			const cls = this.classOf(ref.from_id);
			if (cls !== undefined) {
				const hit = receiver === "parent" ? this.parentMember(cls, ref.name) : this.member(cls, ref.name);
				if (hit !== undefined) return exact(hit);
				if (this.hasExternalAncestor(cls)) return external();
			}
			return unresolved();
		}
		return this.memberFallback(ref.name);
	}

	// ── shared ─────────────────────────────────────────────────────────────

	private classOf(symbolId: number | null): number | undefined {
		let current = symbolId === null ? undefined : this.symbols.get(symbolId);
		while (current) {
			if (TYPES.has(current.kind)) return current.id;
			current = current.parent_id === null ? undefined : this.symbols.get(current.parent_id);
		}
		return undefined;
	}

	private member(cls: number, name: string, depth = 0): number | undefined {
		const own = this.members.get(cls)?.get(name);
		if (own !== undefined) return own;
		return depth > 8 ? undefined : this.parentMember(cls, name, depth);
	}

	private parentMember(cls: number, name: string, depth = 0): number | undefined {
		for (const parent of this.parents.get(cls) ?? []) {
			const hit = this.member(parent, name, depth + 1);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}

	private hasExternalAncestor(cls: number, depth = 0): boolean {
		if (this.externalParent.has(cls)) return true;
		if (depth > 8) return false;
		return (this.parents.get(cls) ?? []).some((p) => this.hasExternalAncestor(p, depth + 1));
	}

	/** `obj.name()` with an unknown receiver: only trust a unique project-wide method name. */
	private memberFallback(name: string): Outcome {
		const candidates = (this.byName.get(name) ?? []).filter((id) => {
			const s = this.symbols.get(id);
			return s !== undefined && s.parent_id !== null && MEMBER_KINDS.has(s.kind);
		});
		return fallback(candidates);
	}

	private byNameFallback(name: string, kinds: Set<string>): Outcome {
		const candidates = (this.byName.get(name) ?? []).filter((id) => {
			const s = this.symbols.get(id);
			return s !== undefined && s.parent_id === null && kinds.has(s.kind);
		});
		return fallback(candidates);
	}

	private pick(ids: number[] | undefined, kinds?: Set<string>): number | undefined {
		if (!ids) return undefined;
		if (!kinds) return ids[0];
		return ids.find((id) => kinds.has(this.symbols.get(id)?.kind ?? ""));
	}
}

function kindsFor(refKind: string): Set<string> {
	if (refKind === "call") return CALLABLE;
	if (refKind === "render") return RENDERABLE;
	return TYPES;
}

function fallback(candidates: number[]): Outcome {
	if (candidates.length === 1) return { target: candidates[0] as number, resolution: "inferred" };
	if (candidates.length > 1) return { target: null, resolution: "ambiguous" };
	return unresolved();
}

function exact(target: number): Outcome {
	return { target, resolution: "exact" };
}

function external(): Outcome {
	return { target: null, resolution: "external" };
}

function unresolved(): Outcome {
	return { target: null, resolution: "unresolved" };
}

function mapFor<K, K2, V>(map: Map<K, Map<K2, V>>, key: K): Map<K2, V> {
	let inner = map.get(key);
	if (!inner) {
		inner = new Map();
		map.set(key, inner);
	}
	return inner;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}
