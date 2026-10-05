import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta } from "./db";
import type { Resolution } from "./link";

export interface SymbolInfo {
	id: number;
	name: string;
	qualifiedName: string;
	kind: string;
	path: string;
	lang: string;
	startLine: number;
	endLine: number;
	signature: string;
	exported: boolean;
}

export interface Edge {
	/** The other end of the edge; null when the reference sits in file-level code. */
	symbol: SymbolInfo | null;
	/** Unresolved or external target name (callees only). */
	name: string;
	path: string;
	line: number;
	kind: string;
	resolution: Resolution;
}

export interface Lookup {
	symbol: SymbolInfo | undefined;
	alternatives: SymbolInfo[];
}

export interface ImpactEntry {
	symbol: SymbolInfo;
	depth: number;
}

export interface TraceStep {
	symbol: SymbolInfo;
	line: number | null;
}

export interface ContextEntry {
	symbol: SymbolInfo;
	score: number;
	callers: string[];
	callees: string[];
	code?: string;
}

export interface ExploreFile {
	path: string;
	blocks: { symbol: SymbolInfo; code: string }[];
}

export interface FileInfo {
	path: string;
	lang: string;
	lines: number;
	symbols: number;
	error: string | null;
}

export interface Status {
	root: string;
	files: number;
	symbols: number;
	refs: number;
	languages: Record<string, number>;
	resolution: Record<string, number>;
	failed: { path: string; error: string }[];
	lastSync: string | undefined;
}

const SYMBOL_COLUMNS = `s.id, s.name, s.qualified_name AS qualifiedName, s.kind, f.path, f.lang,
	s.start_line AS startLine, s.end_line AS endLine, s.signature, s.exported`;

const KIND_WEIGHT: Record<string, number> = {
	class: 3,
	interface: 2,
	trait: 2,
	enum: 1,
	type: 1,
	function: 3,
	method: 2,
	property: -1,
	constant: 0,
	variable: -1,
};

const STOPWORDS = new Set(
	(
		"the and for with that this from into how does what where when which who why are was were has have " +
		"not but all any can could should would will there their them then than also like just only " +
		"como que para por con los las del una uno donde cuando funciona hace este esta"
	).split(" "),
);

/** Common verbs and nouns: noise in prose, but real method names (`find`, `get`). Exact matches only. */
const WEAK_WORDS = new Set(
	(
		"use uses used using work works make makes get set add new file code function method class find show " +
		"list create update delete remove load save read write run handle check"
	).split(" "),
);

type RawSymbol = Omit<SymbolInfo, "exported"> & { exported: number };

/** Read-only queries over the index. */
export class Graph {
	constructor(
		readonly db: Database,
		readonly root: string,
	) {}

	status(): Status {
		const count = (sql: string) => (this.db.query<{ n: number }, []>(sql).get()?.n ?? 0) as number;
		const languages: Record<string, number> = {};
		for (const row of this.db
			.query<{ lang: string; n: number }, []>("SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY lang")
			.all()) {
			languages[row.lang] = row.n;
		}
		const resolution: Record<string, number> = {};
		for (const row of this.db
			.query<{ resolution: string; n: number }, []>(
				"SELECT resolution, COUNT(*) AS n FROM refs GROUP BY resolution ORDER BY n DESC",
			)
			.all()) {
			resolution[row.resolution] = row.n;
		}
		return {
			root: this.root,
			files: count("SELECT COUNT(*) AS n FROM files"),
			symbols: count("SELECT COUNT(*) AS n FROM symbols"),
			refs: count("SELECT COUNT(*) AS n FROM refs"),
			languages,
			resolution,
			failed: this.db
				.query<{ path: string; error: string }, []>(
					"SELECT path, error FROM files WHERE error IS NOT NULL ORDER BY path LIMIT 50",
				)
				.all(),
			lastSync: getMeta(this.db, "last_sync"),
		};
	}

	search(input: { query: string; kind?: string; lang?: string; limit?: number }): SymbolInfo[] {
		const query = input.query.trim();
		if (!query) return [];
		const filters: string[] = ["(s.name LIKE ?1 ESCAPE '\\' OR s.qualified_name LIKE ?1 ESCAPE '\\')"];
		const params: string[] = [`%${escapeLike(query)}%`];
		if (input.kind) {
			filters.push(`s.kind = ?${params.length + 1}`);
			params.push(input.kind);
		}
		if (input.lang) {
			filters.push(`f.lang = ?${params.length + 1}`);
			params.push(input.lang === "jsx" ? "javascript" : input.lang);
		}
		const rows = this.symbolsWhere(filters.join(" AND "), params, 1000);
		const lower = query.toLowerCase();
		const rank = (s: SymbolInfo) => {
			const name = s.name.toLowerCase();
			let score = 0;
			if (s.name === query || s.qualifiedName === query) score += 100;
			else if (name === lower) score += 80;
			else if (name.startsWith(lower)) score += 50;
			else if (name.includes(lower)) score += 30;
			else score += 10; // matched through the qualified name
			return score + (KIND_WEIGHT[s.kind] ?? 0) + (s.exported ? 1 : 0) - s.path.length / 1000;
		};
		return rows
			.map((s) => [s, rank(s)] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, input.limit ?? 20)
			.map(([s]) => s);
	}

	/**
	 * Resolves a user-supplied symbol reference. Accepts an id (`#12`), a
	 * qualified name (`Class.method`, `App\Foo::bar`), `path:name`, or a bare name.
	 */
	lookup(ref: string): Lookup {
		const text = ref.trim();
		const idMatch = /^#?(\d+)$/.exec(text);
		if (idMatch) {
			const hit = this.symbolsWhere("s.id = ?1", [idMatch[1] as string], 1);
			return { symbol: hit[0], alternatives: [] };
		}

		const colon = text.lastIndexOf(":");
		if (colon > 0 && text[colon - 1] !== ":" && text[colon + 1] !== ":") {
			const path = text.slice(0, colon);
			const name = text.slice(colon + 1);
			const hits = this.symbolsWhere(
				"(f.path = ?1 OR f.path LIKE ?2 ESCAPE '\\') AND (s.name = ?3 OR s.qualified_name = ?3)",
				[path, `%${escapeLike(path)}`, name],
				20,
			);
			if (hits.length > 0) return this.best(hits);
		}

		for (const where of [
			"s.qualified_name = ?1",
			"s.name = ?1",
			"s.qualified_name = ?1 COLLATE NOCASE",
			"s.name = ?1 COLLATE NOCASE",
		]) {
			const hits = this.symbolsWhere(where, [text], 50);
			if (hits.length > 0) return this.best(hits);
		}
		// `Class.method` written against a PHP `Class::method` symbol, or vice versa.
		// A qualified suffix also matches (`Signup::register` → `App\Services\Signup::register`),
		// as does `Class.method` written against a PHP `Class::method`, and vice versa.
		const alt = text.includes("::") ? text.replace("::", ".") : text.replace(".", "::");
		for (const form of new Set([text, alt])) {
			const hits = this.symbolsWhere("s.qualified_name LIKE ?1 ESCAPE '\\'", [`%${escapeLike(form)}`], 20);
			if (hits.length > 0) return this.best(hits);
		}
		return { symbol: undefined, alternatives: this.search({ query: text, limit: 5 }) };
	}

	callers(symbol: SymbolInfo, limit = 50): Edge[] {
		const rows = this.db
			.query<EdgeRow, [number, number]>(
				`SELECT r.kind AS edgeKind, r.line, r.name AS refName, r.resolution, rf.path AS refPath, ${SYMBOL_COLUMNS}
				 FROM refs r
				 JOIN files rf ON rf.id = r.file_id
				 LEFT JOIN symbols s ON s.id = r.from_id
				 LEFT JOIN files f ON f.id = s.file_id
				 WHERE r.target_id = ?1
				 ORDER BY r.resolution = 'exact' DESC, rf.path, r.line
				 LIMIT ?2`,
			)
			.all(symbol.id, limit);
		return rows.map(toEdge);
	}

	callees(symbol: SymbolInfo, opts: { limit?: number; includeExternal?: boolean } = {}): Edge[] {
		const ids = [symbol.id, ...this.memberIds(symbol.id)];
		const resolvedOnly = opts.includeExternal ? "" : "AND r.target_id IS NOT NULL";
		const rows = this.db
			.query<EdgeRow, number[]>(
				`SELECT r.kind AS edgeKind, r.line, r.name AS refName, r.resolution, rf.path AS refPath, ${SYMBOL_COLUMNS}
				 FROM refs r
				 JOIN files rf ON rf.id = r.file_id
				 LEFT JOIN symbols s ON s.id = r.target_id
				 LEFT JOIN files f ON f.id = s.file_id
				 WHERE r.from_id IN (${ids.map(() => "?").join(",")}) ${resolvedOnly}
				 ORDER BY r.line`,
			)
			.all(...ids);
		// One entry per distinct target; the first call site wins.
		const seen = new Set<string>();
		const edges: Edge[] = [];
		for (const edge of rows.map(toEdge)) {
			const key = edge.symbol ? `#${edge.symbol.id}` : `${edge.resolution}:${edge.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push(edge);
		}
		return edges.slice(0, opts.limit ?? 50);
	}

	/** Everything that (transitively) references the symbol or one of its members. */
	impact(symbol: SymbolInfo, depth = 2): ImpactEntry[] {
		const seen = new Set<number>([symbol.id]);
		let frontier = [symbol.id, ...this.memberIds(symbol.id)];
		for (const id of frontier) seen.add(id);
		const result: ImpactEntry[] = [];
		for (let level = 1; level <= depth && frontier.length > 0; level++) {
			const next: number[] = [];
			for (const chunk of chunks(frontier, 500)) {
				const rows = this.db
					.query<{ id: number }, number[]>(
						`SELECT DISTINCT from_id AS id FROM refs
						 WHERE target_id IN (${chunk.map(() => "?").join(",")}) AND from_id IS NOT NULL`,
					)
					.all(...chunk);
				for (const { id } of rows) {
					if (seen.has(id)) continue;
					seen.add(id);
					next.push(id);
				}
			}
			for (const s of this.byIds(next)) result.push({ symbol: s, depth: level });
			frontier = next;
		}
		return result;
	}

	/** Shortest reference path from one symbol to another (breadth-first). */
	trace(from: SymbolInfo, to: SymbolInfo, maxDepth = 6): TraceStep[] | undefined {
		const prev = new Map<number, { id: number; line: number } | null>([[from.id, null]]);
		let frontier = [from.id];
		const edges = this.db.prepare<{ target: number; line: number }, [number]>(
			"SELECT target_id AS target, line FROM refs WHERE from_id = ? AND target_id IS NOT NULL",
		);
		for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
			const next: number[] = [];
			for (const id of frontier) {
				// A class reaches whatever its members reach.
				for (const source of [id, ...this.memberIds(id)]) {
					for (const edge of edges.all(source)) {
						if (prev.has(edge.target)) continue;
						prev.set(edge.target, { id, line: edge.line });
						if (edge.target === to.id) return this.buildPath(prev, to.id);
						next.push(edge.target);
					}
				}
			}
			frontier = next;
		}
		return undefined;
	}

	members(symbol: SymbolInfo): SymbolInfo[] {
		return this.symbolsWhere("s.parent_id = ?1", [String(symbol.id)], 500).sort((a, b) => a.startLine - b.startLine);
	}

	parent(symbol: SymbolInfo): SymbolInfo | undefined {
		const row = this.db
			.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM symbols WHERE id = ?")
			.get(symbol.id);
		return row?.parent_id ? this.byIds([row.parent_id])[0] : undefined;
	}

	/** Source of a symbol, read from disk; capped at `maxLines`. */
	code(symbol: SymbolInfo, maxLines = 400): string | undefined {
		let text: string;
		try {
			text = readFileSync(join(this.root, symbol.path), "utf8");
		} catch {
			return undefined;
		}
		const lines = text.split("\n").slice(symbol.startLine - 1, symbol.endLine);
		if (lines.length <= maxLines) return lines.join("\n");
		return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
	}

	/** Ranked symbols for a natural-language task, with neighbours and source. */
	context(input: { task: string; maxSymbols?: number; includeCode?: boolean; tokenBudget?: number }): ContextEntry[] {
		const ranked = this.rankByTerms(input.task).slice(0, input.maxSymbols ?? 8);
		let budget = (input.tokenBudget ?? 6000) * 4;
		return ranked.map(({ symbol, score }) => {
			const entry: ContextEntry = {
				symbol,
				score,
				callers: [...new Set(this.callers(symbol, 20).map(edgeLabel))].slice(0, 5),
				callees: [...new Set(this.callees(symbol, { limit: 20 }).map(edgeLabel))].slice(0, 5),
			};
			if (input.includeCode !== false && budget > 0) {
				const code = this.code(symbol, 120);
				if (code) {
					entry.code = code.length > budget ? `${code.slice(0, budget)}\n… (truncated)` : code;
					budget -= entry.code.length;
				}
			}
			return entry;
		});
	}

	/** Source blocks for every symbol matching the query terms, grouped by file. */
	explore(input: { query: string; maxFiles?: number }): ExploreFile[] {
		const ranked = this.rankByTerms(input.query, 200);
		const byFile = new Map<string, { score: number; symbols: SymbolInfo[] }>();
		for (const { symbol, score } of ranked) {
			const group = byFile.get(symbol.path) ?? { score: 0, symbols: [] };
			group.score += score;
			group.symbols.push(symbol);
			byFile.set(symbol.path, group);
		}
		let budget = 60_000;
		const files: ExploreFile[] = [];
		const ordered = [...byFile].sort((a, b) => b[1].score - a[1].score).slice(0, input.maxFiles ?? 12);
		for (const [path, group] of ordered) {
			const blocks: ExploreFile["blocks"] = [];
			const covered: [number, number][] = [];
			// Smallest blocks first, so a matched method wins over its whole class.
			for (const symbol of group.symbols.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))) {
				if (budget <= 0) break;
				if (covered.some(([s, e]) => symbol.startLine >= s && symbol.endLine <= e)) continue;
				const code = this.code(symbol, 150);
				if (!code) continue;
				covered.push([symbol.startLine, symbol.endLine]);
				blocks.push({ symbol, code });
				budget -= code.length;
			}
			blocks.sort((a, b) => a.symbol.startLine - b.symbol.startLine);
			if (blocks.length > 0) files.push({ path, blocks });
		}
		return files;
	}

	files(input: { path?: string; pattern?: string } = {}): FileInfo[] {
		const rows = this.db
			.query<FileInfo, []>(
				`SELECT f.path, f.lang, f.lines, f.error, (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id) AS symbols
				 FROM files f ORDER BY f.path`,
			)
			.all();
		const prefix = input.path?.replace(/^\.\//, "").replace(/\/$/, "");
		const glob = input.pattern ? new Bun.Glob(input.pattern) : undefined;
		return rows.filter(
			(f) => (!prefix || f.path === prefix || f.path.startsWith(`${prefix}/`)) && (!glob || glob.match(f.path)),
		);
	}

	// ── internals ──────────────────────────────────────────────────────────

	private rankByTerms(text: string, limit = 50): { symbol: SymbolInfo; score: number }[] {
		const terms = extractTerms(text);
		const scores = new Map<number, { symbol: SymbolInfo; score: number }>();
		const bump = (symbol: SymbolInfo, points: number) => {
			const entry = scores.get(symbol.id) ?? { symbol, score: 0 };
			entry.score += points;
			scores.set(symbol.id, entry);
		};
		for (const { term, exactWeight } of terms) {
			if (WEAK_WORDS.has(term)) {
				for (const s of this.symbolsWhere("s.name = ?1 COLLATE NOCASE", [term], 300)) bump(s, exactWeight);
				continue;
			}
			for (const s of this.symbolsWhere("s.name LIKE ?1 ESCAPE '\\'", [`%${escapeLike(term)}%`], 300)) {
				const name = s.name.toLowerCase();
				if (name === term) bump(s, exactWeight);
				else if (name.startsWith(term)) bump(s, 5);
				else bump(s, 2);
			}
			for (const s of this.symbolsWhere(
				"f.path LIKE ?1 ESCAPE '\\' AND s.parent_id IS NULL",
				[`%${escapeLike(term)}%`],
				100,
			)) {
				bump(s, 1);
			}
		}
		const candidates = [...scores.values()];
		for (const entry of candidates) {
			entry.score += KIND_WEIGHT[entry.symbol.kind] ?? 0;
			// "indexer sync" should prefer Indexer.sync over any other sync.
			const owner = entry.symbol.qualifiedName.slice(0, -entry.symbol.name.length).toLowerCase();
			for (const { term } of terms) if (owner.includes(term)) entry.score += 6;
		}
		candidates.sort((a, b) => b.score - a.score);
		const top = candidates.slice(0, limit);
		// Well-connected symbols are better entry points.
		const degree = this.db.prepare<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM refs WHERE target_id = ?");
		for (const entry of top) entry.score += Math.log2(1 + (degree.get(entry.symbol.id)?.n ?? 0));
		return top.sort((a, b) => b.score - a.score);
	}

	private best(hits: SymbolInfo[]): Lookup {
		const sorted = [...hits].sort(
			(a, b) => (KIND_WEIGHT[b.kind] ?? 0) + Number(b.exported) - ((KIND_WEIGHT[a.kind] ?? 0) + Number(a.exported)),
		);
		return { symbol: sorted[0], alternatives: sorted.slice(1, 6) };
	}

	private memberIds(id: number): number[] {
		return this.db
			.query<{ id: number }, [number]>("SELECT id FROM symbols WHERE parent_id = ?")
			.all(id)
			.map((r) => r.id);
	}

	private byIds(ids: number[]): SymbolInfo[] {
		const out: SymbolInfo[] = [];
		for (const chunk of chunks(ids, 500)) {
			out.push(...this.symbolsWhere(`s.id IN (${chunk.join(",")})`, [], chunk.length));
		}
		const order = new Map(ids.map((id, i) => [id, i]));
		return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	}

	private symbolsWhere(where: string, params: string[], limit: number): SymbolInfo[] {
		return this.db
			.query<RawSymbol, string[]>(
				`SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE ${where} LIMIT ${limit}`,
			)
			.all(...params)
			.map((s) => ({ ...s, exported: s.exported === 1 }));
	}

	private buildPath(prev: Map<number, { id: number; line: number } | null>, end: number): TraceStep[] {
		const steps: { id: number; line: number | null }[] = [];
		let current: number | undefined = end;
		let line: number | null = null;
		while (current !== undefined) {
			const link = prev.get(current);
			steps.unshift({ id: current, line });
			line = link?.line ?? null;
			current = link?.id;
		}
		// Each step carries the line where it calls the next one.
		const symbols = new Map(this.byIds(steps.map((s) => s.id)).map((s) => [s.id, s]));
		const out: TraceStep[] = [];
		for (let i = 0; i < steps.length; i++) {
			const symbol = symbols.get(steps[i]?.id as number);
			if (symbol) out.push({ symbol, line: i + 1 < steps.length ? (steps[i + 1]?.line ?? null) : null });
		}
		return out;
	}
}

interface EdgeRow extends Partial<RawSymbol> {
	edgeKind: string;
	line: number;
	refName: string;
	resolution: Resolution;
	refPath: string;
}

function toEdge(row: EdgeRow): Edge {
	const symbol =
		row.id != null
			? ({
					id: row.id,
					name: row.name,
					qualifiedName: row.qualifiedName,
					kind: row.kind,
					path: row.path,
					lang: row.lang,
					startLine: row.startLine,
					endLine: row.endLine,
					signature: row.signature,
					exported: row.exported === 1,
				} as SymbolInfo)
			: null;
	return {
		symbol,
		name: row.refName,
		path: row.refPath,
		line: row.line,
		kind: row.edgeKind,
		resolution: row.resolution,
	};
}

function edgeLabel(edge: Edge): string {
	return edge.symbol ? edge.symbol.qualifiedName : `${edge.path} (file level)`;
}

/** Task text → search terms. Identifiers keep a high exact-match weight; their parts a lower one. */
export function extractTerms(text: string): { term: string; exactWeight: number }[] {
	const terms = new Map<string, number>();
	const add = (term: string, weight: number) => {
		const lower = term.toLowerCase();
		if (lower.length < 3 || STOPWORDS.has(lower)) return;
		terms.set(lower, Math.max(terms.get(lower) ?? 0, WEAK_WORDS.has(lower) ? 4 : weight));
	};
	for (const token of text.split(/[^A-Za-z0-9_$\\]+/)) {
		if (!token) continue;
		const isIdentifier = /[a-z][A-Z]|_|\\/.test(token);
		for (const segment of token.split("\\")) add(segment, isIdentifier ? 15 : 10);
		const parts = token.split(/(?<=[a-z0-9])(?=[A-Z])|[_\\]+/);
		if (parts.length > 1) for (const part of parts) add(part, 6);
	}
	return [...terms].slice(0, 16).map(([term, exactWeight]) => ({ term, exactWeight }));
}

function escapeLike(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
