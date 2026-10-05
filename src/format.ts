import type {
	ContextEntry,
	Edge,
	ExploreFile,
	FileInfo,
	ImpactEntry,
	Lookup,
	Status,
	SymbolInfo,
	TraceStep,
} from "./core";

/**
 * Plain-text renderers shared by the CLI and the MCP server.
 *
 * Every renderer works against a token budget. What does not fit is counted
 * and the output says how to get it (`offset=`, a narrower call, a bigger
 * `maxTokens`): an agent must never mistake a cut list for a complete one.
 */

/** Rough token estimate (~4 characters per token for code and English). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Room kept for the trailing "… N more" note. */
const RESERVE = 40;

/** Output lines collected under a token budget. */
export class Out {
	private readonly lines: string[] = [];
	private used = 0;

	constructor(readonly maxTokens: number) {}

	/** Always added: headers and notes. */
	add(...lines: string[]): this {
		for (const line of lines) {
			this.lines.push(line);
			this.used += estimateTokens(line) + 1;
		}
		return this;
	}

	/** Added only if it fits while keeping room for a closing note. */
	fit(text: string): boolean {
		const cost = estimateTokens(text) + 1;
		if (this.used + cost > this.maxTokens - RESERVE) return false;
		this.lines.push(text);
		this.used += cost;
		return true;
	}

	/** Tokens still available for content. */
	get left(): number {
		return this.maxTokens - RESERVE - this.used;
	}

	toString(): string {
		return this.lines.join("\n");
	}
}

export interface Page {
	offset: number;
	limit: number;
}

/**
 * Renders `items[offset, offset+limit)` as far as the budget allows, optionally
 * grouped under a header line, and closes with how to get the rest.
 */
function renderList<T>(
	out: Out,
	items: T[],
	page: Page,
	line: (item: T) => string,
	group?: (item: T) => string,
	/** How to get the rest when there is no `offset` to continue with. */
	hint?: string,
): void {
	const end = Math.min(items.length, page.offset + page.limit);
	let current: string | undefined;
	let shown = page.offset;
	for (let i = page.offset; i < end; i++) {
		const item = items[i] as T;
		const header = group?.(item);
		const text = header !== undefined && header !== current ? `${header}\n${line(item)}` : line(item);
		if (!out.fit(text)) break;
		current = header;
		shown = i + 1;
	}
	if (shown < items.length) {
		const range = `showing ${page.offset + 1}–${shown} of ${items.length}`;
		const how =
			hint ??
			(shown < end
				? `budget reached; raise maxTokens or continue with offset=${shown}`
				: `continue with offset=${shown}`);
		out.add(`… ${items.length - shown} more (${range}); ${how}`);
	}
}

export function symbolLine(s: SymbolInfo): string {
	return `${s.kind} ${s.qualifiedName}  ${s.path}:${s.startLine}  #${s.id}`;
}

export function formatSearch(query: string, results: SymbolInfo[], page: Page, maxTokens: number): string {
	if (results.length === 0) return `No symbols match "${query}".`;
	const out = new Out(maxTokens).add(`Symbols matching "${query}":`);
	renderList(out, results, page, (s) => `  ${symbolLine(s)}`);
	return out.toString();
}

export function formatNotFound(ref: string, lookup: Lookup): string {
	const lines = [`No symbol matches "${ref}".`];
	if (lookup.alternatives.length > 0) {
		lines.push("Closest matches:", ...lookup.alternatives.map((s) => `  ${symbolLine(s)}`));
	}
	return lines.join("\n");
}

function alsoMatches(out: Out, lookup: Lookup): void {
	if (lookup.alternatives.length === 0) return;
	out.add("", "Other symbols share this name (pass #id to pick one):");
	for (const s of lookup.alternatives) if (!out.fit(`  ${symbolLine(s)}`)) break;
}

export function formatNode(
	lookup: Lookup & { symbol: SymbolInfo },
	extra: { parent?: SymbolInfo; members: SymbolInfo[]; callers: number; callees: number; code?: string },
	maxTokens: number,
): string {
	const s = lookup.symbol;
	const out = new Out(maxTokens).add(
		`${s.kind} ${s.qualifiedName}  #${s.id}`,
		`  location: ${s.path}:${s.startLine}-${s.endLine}`,
		`  signature: ${s.signature}`,
	);
	if (extra.parent) out.add(`  member of: ${extra.parent.qualifiedName}  #${extra.parent.id}`);
	out.add(`  referenced by: ${extra.callers}   references: ${extra.callees}`);
	if (extra.code) out.add("", codeBlock(s, extra.code, out.left - 30));
	if (extra.members.length > 0) {
		out.add("", `members (${extra.members.length}):`);
		renderList(
			out,
			extra.members,
			{ offset: 0, limit: extra.members.length },
			(m) => `  ${outlineLine(m, 0)}`,
			undefined,
			`budget reached; see astrograph_outline #${s.id} or raise maxTokens`,
		);
	}
	alsoMatches(out, lookup);
	return out.toString();
}

function edgeTag(edge: Edge): string {
	const kind = edge.kind === "call" ? "" : ` ${edge.kind}`;
	const tag = edge.resolution === "exact" ? "" : `  [${edge.resolution}]`;
	return `${kind}${tag}`;
}

export function formatCallers(
	lookup: Lookup & { symbol: SymbolInfo },
	edges: Edge[],
	page: Page,
	maxTokens: number,
): string {
	const s = lookup.symbol;
	const out = new Out(maxTokens);
	if (edges.length === 0) {
		out.add(`Nothing in the index references ${s.qualifiedName}.`);
	} else {
		out.add(`${edges.length} reference(s) to ${s.kind} ${s.qualifiedName} (${s.path}:${s.startLine}), by file:`);
		renderList(
			out,
			edges,
			page,
			(e) =>
				`  :${e.line}  ${e.symbol ? `${e.symbol.kind} ${e.symbol.qualifiedName}  #${e.symbol.id}` : "(file level)"}${edgeTag(e)}`,
			(e) => e.path,
		);
		inferredNote(out, edges);
	}
	alsoMatches(out, lookup);
	return out.toString();
}

export function formatCallees(
	lookup: Lookup & { symbol: SymbolInfo },
	edges: Edge[],
	page: Page,
	maxTokens: number,
): string {
	const s = lookup.symbol;
	const out = new Out(maxTokens);
	if (edges.length === 0) {
		out.add(`${s.qualifiedName} references no indexed symbols.`);
	} else {
		out.add(`${edges.length} symbol(s) referenced by ${s.kind} ${s.qualifiedName} (call line → target):`);
		renderList(out, edges, page, (e) =>
			e.symbol
				? `  :${e.line}  ${e.symbol.kind} ${e.symbol.qualifiedName}  ${e.symbol.path}:${e.symbol.startLine}  #${e.symbol.id}${edgeTag(e)}`
				: `  :${e.line}  ${e.name}${edgeTag(e)}`,
		);
		inferredNote(out, edges);
	}
	alsoMatches(out, lookup);
	return out.toString();
}

function inferredNote(out: Out, edges: Edge[]): void {
	if (edges.some((e) => e.resolution === "inferred")) {
		out.add("[inferred] = matched by a unique method name; the receiver's type was not known.");
	}
}

export function formatImpact(
	lookup: Lookup & { symbol: SymbolInfo },
	entries: ImpactEntry[],
	page: Page,
	maxTokens: number,
): string {
	const s = lookup.symbol;
	const out = new Out(maxTokens);
	if (entries.length === 0) {
		out.add(`Nothing in the index depends on ${s.qualifiedName}.`);
	} else {
		const files = new Set(entries.map((e) => e.symbol.path));
		out.add(`Changing ${s.kind} ${s.qualifiedName} may affect ${entries.length} symbol(s) in ${files.size} file(s):`);
		const sorted = [...entries].sort(
			(a, b) =>
				a.depth - b.depth || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.startLine - b.symbol.startLine,
		);
		renderList(
			out,
			sorted,
			page,
			(e) => `    :${e.symbol.startLine}  ${e.symbol.kind} ${e.symbol.qualifiedName}  #${e.symbol.id}`,
			(e) => `${e.depth === 1 ? "direct" : `depth ${e.depth}`}  ${e.symbol.path}`,
		);
	}
	alsoMatches(out, lookup);
	return out.toString();
}

export function formatTrace(
	from: SymbolInfo,
	to: SymbolInfo,
	steps: TraceStep[] | undefined,
	maxDepth: number,
): string {
	if (!steps) return `No reference path from ${from.qualifiedName} to ${to.qualifiedName} within ${maxDepth} hops.`;
	const lines = [`Path from ${from.qualifiedName} to ${to.qualifiedName} (${steps.length - 1} hop(s)):`];
	steps.forEach((step, i) => {
		const at = step.line !== null ? `  → next at line ${step.line}` : "";
		lines.push(`  ${i + 1}. ${symbolLine(step.symbol)}${at}`);
	});
	return lines.join("\n");
}

export function formatContext(task: string, entries: ContextEntry[], maxTokens: number): string {
	if (entries.length === 0)
		return `No indexed symbols relate to "${task}". Try astrograph_search with a specific name.`;
	const out = new Out(maxTokens).add(`Context for "${task}" — ${entries.length} symbol(s), most relevant first:`);
	const signatureOnly: SymbolInfo[] = [];
	entries.forEach((e, i) => {
		const head = [`## ${symbolLine(e.symbol)}  (lines ${e.symbol.startLine}-${e.symbol.endLine})`];
		if (e.callers.length > 0) head.push(`called by: ${e.callers.join(", ")}`);
		if (e.callees.length > 0) head.push(`calls: ${e.callees.join(", ")}`);
		// Keep ~60 tokens per remaining entry so later symbols still get a header.
		const room = out.left - estimateTokens(head.join("\n")) - 60 * (entries.length - i - 1);
		if (e.code && room >= 120) {
			out.fit(["", ...head, codeBlock(e.symbol, e.code, room)].join("\n"));
		} else if (!out.fit(["", ...head, `signature: ${e.symbol.signature}`].join("\n"))) {
			signatureOnly.push(e.symbol);
		}
	});
	if (signatureOnly.length > 0) {
		out.add("", `Budget reached; also relevant (raise maxTokens or use astrograph_node):`);
		listSymbols(out, signatureOnly);
	}
	return out.toString();
}

export function formatExplore(query: string, files: ExploreFile[], maxTokens: number): string {
	if (files.length === 0) return `No indexed symbols match "${query}".`;
	const out = new Out(maxTokens).add(`Source for "${query}" across ${files.length} file(s):`);
	const skipped: SymbolInfo[] = [];
	for (const file of files) {
		let printedHeader = false;
		for (const block of file.blocks) {
			const header = printedHeader ? "" : `\n# ${file.path}\n`;
			const room = out.left - estimateTokens(header) - 20;
			if (room < 120) {
				skipped.push(block.symbol);
				continue;
			}
			out.fit(
				`${header}${block.symbol.kind} ${block.symbol.qualifiedName}  #${block.symbol.id}\n${codeBlock(block.symbol, block.code, room)}`,
			);
			printedHeader = true;
		}
	}
	if (skipped.length > 0) {
		out.add(
			"",
			`${skipped.length} more matching symbol(s) without source (budget reached; raise maxTokens or narrow the query):`,
		);
		listSymbols(out, skipped);
	}
	return out.toString();
}

/** One line per symbol while the budget lasts; the rest is only counted. */
function listSymbols(out: Out, symbols: SymbolInfo[]): void {
	let shown = 0;
	for (const s of symbols) {
		if (!out.fit(`  ${symbolLine(s)}`)) break;
		shown++;
	}
	if (shown < symbols.length) out.add(`  … and ${symbols.length - shown} more`);
}

function outlineLine(s: SymbolInfo, depth: number): string {
	const range = s.startLine === s.endLine ? `${s.startLine}` : `${s.startLine}-${s.endLine}`;
	return `${"  ".repeat(depth)}${range.padEnd(9)} ${s.kind.padEnd(9)} ${s.signature}  #${s.id}`;
}

/** Signatures and line ranges, no bodies: what is in a file, directory or class. */
export function formatOutline(
	target: string,
	groups: { path: string; lines: number; symbols: SymbolInfo[] }[],
	maxTokens: number,
): string {
	if (groups.length === 0) return `Nothing indexed matches "${target}". Try astrograph_files to list indexed paths.`;
	const out = new Out(maxTokens);
	const many = groups.length > 1;
	if (many) out.add(`${groups.length} files under "${target}" (top-level symbols only; outline one file for members):`);
	let shownFiles = 0;
	for (const group of groups) {
		const symbols = group.symbols;
		const depthOf = depthMap(symbols);
		const visible = many ? symbols.filter((s) => s.parentId === null) : symbols;
		const memberCount = symbols.length - visible.length;
		const header = `${many ? "\n" : ""}${group.path} — ${group.lines} lines${memberCount ? `, ${memberCount} members hidden` : ""}`;
		if (!out.fit(header)) break;
		shownFiles++;
		renderList(
			out,
			visible,
			{ offset: 0, limit: visible.length },
			(s) => `  ${outlineLine(s, depthOf.get(s.id) ?? 0)}`,
			undefined,
			"budget reached; outline a single class (#id) or raise maxTokens",
		);
		if (visible.length === 0) out.add("  (no symbols)");
	}
	if (shownFiles < groups.length) {
		out.add(
			`… ${groups.length - shownFiles} more file(s); budget reached. Outline a narrower path or raise maxTokens.`,
		);
	}
	return out.toString();
}

function depthMap(symbols: SymbolInfo[]): Map<number, number> {
	const byId = new Map(symbols.map((s) => [s.id, s]));
	const depth = new Map<number, number>();
	for (const s of symbols) {
		let d = 0;
		for (let p = s.parentId; p !== null && d < 5; p = byId.get(p)?.parentId ?? null) d++;
		depth.set(s.id, d);
	}
	return depth;
}

export function formatFiles(
	files: FileInfo[],
	format: "tree" | "flat" | "grouped",
	maxDepth: number | undefined,
	page: Page,
	maxTokens: number,
): string {
	if (files.length === 0) return "No indexed files match.";
	const out = new Out(maxTokens).add(`${files.length} indexed file(s):`);
	const describe = (f: FileInfo) =>
		`${f.symbols} symbols, ${f.lines} lines${f.error ? `, parse error: ${f.error}` : ""}`;
	if (format === "flat") {
		renderList(out, files, page, (f) => `  ${f.path}  (${describe(f)})`);
	} else if (format === "grouped") {
		const sorted = [...files].sort((a, b) => a.lang.localeCompare(b.lang) || a.path.localeCompare(b.path));
		renderList(
			out,
			sorted,
			page,
			(f) => `  ${f.path}  (${describe(f)})`,
			(f) => f.lang,
		);
	} else {
		// Tree: directory lines are emitted with the first file below them.
		let previous: string[] = [];
		const lines = files.map((f) => {
			const parts = f.path.split("/");
			const dirs = parts.slice(0, -1);
			let common = 0;
			while (common < dirs.length && dirs[common] === previous[common]) common++;
			previous = dirs;
			const text: string[] = [];
			for (let i = common; i < dirs.length; i++) {
				if (maxDepth === undefined || i < maxDepth) text.push(`${"  ".repeat(i + 1)}${dirs[i]}/`);
			}
			if (maxDepth === undefined || dirs.length < maxDepth) {
				text.push(`${"  ".repeat(dirs.length + 1)}${parts.at(-1)}  (${describe(f)})`);
			}
			return text.join("\n");
		});
		renderList(
			out,
			lines.filter((l) => l !== ""),
			page,
			(l) => l,
		);
	}
	return out.toString();
}

export function formatStatus(status: Status): string {
	const total = Object.values(status.resolution).reduce((a, b) => a + b, 0);
	const pct = (n: number | undefined) => (total ? `${Math.round(((n ?? 0) / total) * 100)}%` : "0%");
	const lines = [
		`root: ${status.root}`,
		`files: ${status.files} (${
			Object.entries(status.languages)
				.map(([l, n]) => `${l} ${n}`)
				.join(", ") || "none"
		})`,
		`symbols: ${status.symbols}`,
		`references: ${status.refs}`,
		`  linked to a project symbol: ${pct((status.resolution.exact ?? 0) + (status.resolution.inferred ?? 0))}` +
			` (exact ${status.resolution.exact ?? 0}, inferred by name ${status.resolution.inferred ?? 0})`,
		`  leave the project (libraries, builtins): ${pct(status.resolution.external)}`,
		`  unknown target: ${pct((status.resolution.ambiguous ?? 0) + (status.resolution.unresolved ?? 0))}` +
			` (ambiguous ${status.resolution.ambiguous ?? 0}, unresolved ${status.resolution.unresolved ?? 0})`,
		`last sync: ${status.lastSync ?? "never"}`,
	];
	if (status.failed.length > 0) {
		lines.push(
			`files that failed to parse (${status.failed.length}):`,
			...status.failed.map((f) => `  ${f.path}: ${f.error}`),
		);
	}
	return lines.join("\n");
}

/** Banner appended to every MCP answer: its own cost and the index freshness. */
export function formatFooter(text: string, status: Pick<Status, "files" | "failed" | "lastSync">): string {
	const tokens = estimateTokens(text);
	const cost = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
	const failed = status.failed.length > 0 ? ` · ${status.failed.length} failed to parse` : "";
	return `\n\n— ≈${cost} tokens · ${status.files} files indexed, synced ${ago(status.lastSync)}${failed}`;
}

function ago(iso: string | undefined): string {
	if (!iso) return "never";
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * A fenced code block with source line numbers, cut to `maxTokens`. The cut
 * says which lines are missing, so a follow-up read can target them.
 */
export function codeBlock(s: SymbolInfo, code: string, maxTokens: number): string {
	const lang = s.lang === "php" ? "php" : s.lang === "javascript" ? "js" : "ts";
	const lines = code.split("\n");
	const width = String(s.startLine + lines.length - 1).length;
	const numbered: string[] = [];
	let used = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = `${String(s.startLine + i).padStart(width)}│ ${lines[i]}`;
		used += estimateTokens(line) + 1;
		if (used > maxTokens && numbered.length > 0) {
			const from = s.startLine + i;
			numbered.push(
				`… lines ${from}-${s.startLine + lines.length - 1} not shown (budget); read them directly or raise maxTokens`,
			);
			break;
		}
		numbered.push(line);
	}
	return `\`\`\`${lang}\n${numbered.join("\n")}\n\`\`\``;
}
