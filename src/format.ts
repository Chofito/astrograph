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

/** Plain-text renderers shared by the CLI and the MCP server. */

export function symbolLine(s: SymbolInfo): string {
	return `${s.kind} ${s.qualifiedName}  ${s.path}:${s.startLine}  #${s.id}`;
}

export function formatSearch(query: string, results: SymbolInfo[]): string {
	if (results.length === 0) return `No symbols match "${query}".`;
	return [`${results.length} symbol(s) matching "${query}":`, ...results.map((s) => `  ${symbolLine(s)}`)].join("\n");
}

export function formatNotFound(ref: string, lookup: Lookup): string {
	const lines = [`No symbol matches "${ref}".`];
	if (lookup.alternatives.length > 0) {
		lines.push("Closest matches:", ...lookup.alternatives.map((s) => `  ${symbolLine(s)}`));
	}
	return lines.join("\n");
}

function alsoMatches(lookup: Lookup): string[] {
	if (lookup.alternatives.length === 0) return [];
	return [
		"",
		"Other symbols share this name (pass #id to pick one):",
		...lookup.alternatives.map((s) => `  ${symbolLine(s)}`),
	];
}

export function formatNode(
	lookup: Lookup & { symbol: SymbolInfo },
	extra: { parent?: SymbolInfo; members: SymbolInfo[]; callers: number; callees: number; code?: string },
): string {
	const s = lookup.symbol;
	const lines = [
		`${s.kind} ${s.qualifiedName}  #${s.id}`,
		`  location: ${s.path}:${s.startLine}-${s.endLine}`,
		`  signature: ${s.signature}`,
	];
	if (extra.parent) lines.push(`  member of: ${extra.parent.qualifiedName}`);
	lines.push(`  referenced by: ${extra.callers}   references: ${extra.callees}`);
	if (extra.members.length > 0) {
		lines.push("", `members (${extra.members.length}):`);
		for (const m of extra.members.slice(0, 60)) lines.push(`  ${m.kind} ${m.name}  :${m.startLine}`);
		if (extra.members.length > 60) lines.push(`  … ${extra.members.length - 60} more`);
	}
	if (extra.code) lines.push("", fence(s, extra.code));
	return [...lines, ...alsoMatches(lookup)].join("\n");
}

function edgeLine(edge: Edge): string {
	const who = edge.symbol ? `${edge.symbol.kind} ${edge.symbol.qualifiedName}` : "(file level)";
	const tag = edge.resolution === "exact" ? "" : `  [${edge.resolution}]`;
	const kind = edge.kind === "call" ? "" : ` ${edge.kind}`;
	return `  ${edge.path}:${edge.line}  ${who}${kind}${tag}`;
}

export function formatCallers(lookup: Lookup & { symbol: SymbolInfo }, edges: Edge[]): string {
	const s = lookup.symbol;
	if (edges.length === 0)
		return [`Nothing in the index references ${s.qualifiedName}.`, ...alsoMatches(lookup)].join("\n");
	return [
		`${edges.length} reference(s) to ${s.kind} ${s.qualifiedName} (${s.path}:${s.startLine}):`,
		...edges.map(edgeLine),
		...inferredNote(edges),
		...alsoMatches(lookup),
	].join("\n");
}

export function formatCallees(lookup: Lookup & { symbol: SymbolInfo }, edges: Edge[]): string {
	const s = lookup.symbol;
	if (edges.length === 0)
		return [`${s.qualifiedName} references no indexed symbols.`, ...alsoMatches(lookup)].join("\n");
	const lines = [`${edges.length} symbol(s) referenced by ${s.kind} ${s.qualifiedName}:`];
	for (const edge of edges) {
		const tag = edge.resolution === "exact" ? "" : `  [${edge.resolution}]`;
		const kind = edge.kind === "call" ? "" : ` (${edge.kind})`;
		if (edge.symbol) {
			lines.push(
				`  :${edge.line}  ${edge.symbol.kind} ${edge.symbol.qualifiedName}${kind}  ${edge.symbol.path}:${edge.symbol.startLine}${tag}`,
			);
		} else {
			lines.push(`  :${edge.line}  ${edge.name}${kind}${tag}`);
		}
	}
	return [...lines, ...inferredNote(edges), ...alsoMatches(lookup)].join("\n");
}

function inferredNote(edges: Edge[]): string[] {
	return edges.some((e) => e.resolution === "inferred")
		? ["", "[inferred] = matched by a unique method name; the receiver's type was not known."]
		: [];
}

export function formatImpact(lookup: Lookup & { symbol: SymbolInfo }, entries: ImpactEntry[], depth: number): string {
	const s = lookup.symbol;
	if (entries.length === 0)
		return [`Nothing in the index depends on ${s.qualifiedName}.`, ...alsoMatches(lookup)].join("\n");
	const files = new Set(entries.map((e) => e.symbol.path));
	const lines = [
		`Changing ${s.kind} ${s.qualifiedName} may affect ${entries.length} symbol(s) in ${files.size} file(s):`,
	];
	for (let level = 1; level <= depth; level++) {
		const atLevel = entries.filter((e) => e.depth === level);
		if (atLevel.length === 0) continue;
		lines.push("", level === 1 ? "direct:" : `depth ${level}:`);
		for (const e of atLevel.slice(0, 80)) lines.push(`  ${symbolLine(e.symbol)}`);
		if (atLevel.length > 80) lines.push(`  … ${atLevel.length - 80} more`);
	}
	return [...lines, ...alsoMatches(lookup)].join("\n");
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
		const at = step.line !== null ? `  → calls next at line ${step.line}` : "";
		lines.push(
			`  ${i + 1}. ${step.symbol.kind} ${step.symbol.qualifiedName}  ${step.symbol.path}:${step.symbol.startLine}${at}`,
		);
	});
	return lines.join("\n");
}

export function formatContext(task: string, entries: ContextEntry[]): string {
	if (entries.length === 0)
		return `No indexed symbols relate to "${task}". Try astrograph_search with a specific name.`;
	const lines = [`Context for "${task}" — ${entries.length} symbol(s), most relevant first:`];
	for (const e of entries) {
		lines.push(
			"",
			`## ${e.symbol.kind} ${e.symbol.qualifiedName}  ${e.symbol.path}:${e.symbol.startLine}-${e.symbol.endLine}  #${e.symbol.id}`,
		);
		if (e.callers.length > 0) lines.push(`called by: ${e.callers.join(", ")}`);
		if (e.callees.length > 0) lines.push(`calls: ${e.callees.join(", ")}`);
		lines.push(e.code ? fence(e.symbol, e.code) : `signature: ${e.symbol.signature}`);
	}
	return lines.join("\n");
}

export function formatExplore(query: string, files: ExploreFile[]): string {
	if (files.length === 0) return `No indexed symbols match "${query}".`;
	const lines = [`Source for "${query}" across ${files.length} file(s):`];
	for (const file of files) {
		lines.push("", `# ${file.path}`);
		for (const block of file.blocks) {
			lines.push(
				`${block.symbol.kind} ${block.symbol.qualifiedName} (lines ${block.symbol.startLine}-${block.symbol.endLine})`,
			);
			lines.push(fence(block.symbol, block.code));
		}
	}
	return lines.join("\n");
}

export function formatFiles(
	files: FileInfo[],
	format: "tree" | "flat" | "grouped" = "tree",
	maxDepth?: number,
): string {
	if (files.length === 0) return "No indexed files match.";
	const header = `${files.length} indexed file(s):`;
	const describe = (f: FileInfo) =>
		`${f.symbols} symbols, ${f.lines} lines${f.error ? `, parse error: ${f.error}` : ""}`;
	if (format === "flat") return [header, ...files.map((f) => `  ${f.path}  (${describe(f)})`)].join("\n");
	if (format === "grouped") {
		const byLang = new Map<string, FileInfo[]>();
		for (const f of files) byLang.set(f.lang, [...(byLang.get(f.lang) ?? []), f]);
		const lines = [header];
		for (const [lang, list] of byLang) {
			lines.push("", `${lang} (${list.length}):`, ...list.map((f) => `  ${f.path}  (${describe(f)})`));
		}
		return lines.join("\n");
	}
	const lines = [header];
	let previous: string[] = [];
	for (const f of files) {
		const parts = f.path.split("/");
		const dirs = parts.slice(0, -1);
		let common = 0;
		while (common < dirs.length && dirs[common] === previous[common]) common++;
		for (let i = common; i < dirs.length; i++) {
			if (maxDepth === undefined || i < maxDepth) lines.push(`${"  ".repeat(i + 1)}${dirs[i]}/`);
		}
		if (maxDepth === undefined || dirs.length < maxDepth) {
			lines.push(`${"  ".repeat(dirs.length + 1)}${parts.at(-1)}  (${describe(f)})`);
		}
		previous = dirs;
	}
	return lines.join("\n");
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

/** One-line freshness banner appended to every MCP answer. */
export function formatFooter(status: Pick<Status, "files" | "failed" | "lastSync">): string {
	const failed = status.failed.length > 0 ? `, ${status.failed.length} failed to parse (see astrograph_status)` : "";
	return `\n\n— index: ${status.files} files, synced ${status.lastSync ?? "never"}${failed}. Code shown above is current; no need to re-read it.`;
}

function fence(s: SymbolInfo, code: string): string {
	const lang = s.lang === "php" ? "php" : s.lang === "javascript" ? "js" : "ts";
	return `\`\`\`${lang}\n${code}\n\`\`\``;
}
