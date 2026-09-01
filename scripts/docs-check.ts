#!/usr/bin/env bun
/**
 * Static documentation guard (DEV-016).
 *
 * Catches the drift a reviewer reliably misses: a link that no longer resolves,
 * an architecture document without its provenance metadata, an unbalanced
 * Mermaid fence, a duplicated deviation ID, a canonical document that quietly
 * disappeared. It does NOT generate prose from code and it does NOT judge
 * whether a claim is true — only whether the document set is internally
 * consistent and navigable.
 *
 *   bun run docs:check              # exit 1 on errors, 0 on warnings
 *   bun run docs:check --warn-only  # always exit 0 (CI warning mode)
 *   bun run docs:check --quiet      # only print findings and the summary
 *
 * Fix a false positive in this script or suppress the single line with
 * `<!-- docs-check: ignore-line -->` on the line above, plus a reason. Never
 * silence a whole document class.
 */

import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

type Severity = "error" | "warn";

interface Finding {
	severity: Severity;
	/** Repo-relative path, so the output is clickable from the repo root. */
	file: string;
	line?: number;
	rule: string;
	message: string;
}

const findings: Finding[] = [];

/**
 * `docs/architecture/README.md` declares `*.es.md` a stale mirror that cannot
 * outrank the English document. Their drift is real and stays visible, but it
 * must never gate a change to the canonical English set.
 */
function isStaleMirror(path: string): boolean {
	return path.endsWith(".es.md");
}

function report(finding: Finding): void {
	findings.push(
		isStaleMirror(finding.file) ? { ...finding, severity: "warn" } : finding,
	);
}

/* -------------------------------------------------------------------------- */
/* Document set                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Documents whose absence breaks a documented reading path or precedence rule.
 * Deliberately short: this is a floor, not a generated inventory.
 */
const REQUIRED_DOCS = [
	"README.md",
	"ROADMAP.md",
	"docs/contracts.md",
	"docs/tools.md",
	"docs/cli.md",
	"docs/mcp.md",
	"docs/install.md",
	"docs/architecture/README.md",
	"docs/architecture/document-template.md",
	"docs/architecture/documentation-checklist.md",
	"docs/architecture/code-map.md",
	"docs/architecture/deviations.md",
	"docs/architecture/glossary.md",
	"docs/architecture/system-overview.md",
	"docs/architecture/indexing-pipeline.md",
	"docs/architecture/incremental-sync.md",
	"docs/architecture/storage-and-graph-model.md",
	"docs/architecture/query-and-honesty.md",
	"docs/architecture/configuration-and-invalidation.md",
	"docs/architecture/extension-guide.md",
	"docs/architecture/extraction/backend-contract.md",
	"docs/architecture/extraction/tree-sitter-pass-a.md",
	"docs/architecture/extraction/typescript-enricher.md",
	"docs/architecture/extraction/php-enricher.md",
	"docs/architecture/surfaces/cli.md",
	"docs/architecture/surfaces/mcp.md",
	"docs/architecture/decisions/README.md",
];

/** Metadata is required here because these documents claim AS-IS/TO-BE authority. */
const METADATA_GLOBS = ["docs/architecture/**/*.md"];

/** Every `Status:` value must start with one of these; a qualifier may follow. */
const STATUS_WORDS = ["current", "target", "mixed", "historical"];

/** ADRs carry decision status, not implementation status. */
const ADR_STATUS_WORDS = [
	"proposed",
	"accepted",
	"rejected",
	"superseded",
	"deprecated",
];

/** Scanned for links, anchors, and Mermaid balance. */
const SCANNED_GLOBS = ["docs/**/*.md", "*.md"];

/** Not documentation: vendored, generated, or dependency trees. */
const IGNORED_PREFIXES = ["node_modules/", "dist/", "apps/site/.astro/"];

/* -------------------------------------------------------------------------- */
/* Markdown helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Blank out fenced code blocks, keeping every byte offset so line numbers stay
 * correct. Link syntax inside an example is an example, not a link.
 */
function maskFences(text: string): string {
	const lines = text.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const isFence = /^[ \t]*(`{3,}|~{3,})/.test(line);
		if (isFence) {
			inFence = !inFence;
			lines[i] = " ".repeat(line.length);
			continue;
		}
		if (inFence) lines[i] = " ".repeat(line.length);
	}
	return lines.join("\n");
}

/**
 * Also blank inline code spans. Used for link extraction only: a backticked
 * `path/to/file.ts` is a citation, not a link. Headings keep their inline code,
 * because GitHub folds it into the anchor slug.
 */
function maskCode(text: string): string {
	return maskFences(text).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === "\n") line += 1;
	}
	return line;
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/<[^>]*>/g, "")
		.replace(/[`*_~]/g, "")
		.replace(/[^\p{L}\p{N} -]/gu, "")
		.replace(/ /g, "-");
}

/** Every anchor a link may target: heading slugs (de-duplicated) plus HTML ids. */
function anchorsOf(text: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	const masked = maskFences(text);

	for (const match of masked.matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
		const base = slugify(match[2] ?? "");
		if (base.length === 0) continue;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		anchors.add(count === 0 ? base : `${base}-${count}`);
	}

	for (const match of text.matchAll(/<a[^>]+(?:name|id)="([^"]+)"/g)) {
		anchors.add((match[1] ?? "").toLowerCase());
	}

	return anchors;
}

function isExternal(target: string): boolean {
	return /^(https?:|mailto:|tel:|ftp:|data:|\/\/)/i.test(target);
}

function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return parts.join("/");
}

function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

interface Doc {
	path: string;
	text: string;
	masked: string;
	anchors: Set<string>;
	/** Lines suppressed by a preceding `<!-- docs-check: ignore-line -->`. */
	suppressed: Set<number>;
}

async function loadDocs(): Promise<Map<string, Doc>> {
	const paths = new Set<string>();
	for (const pattern of SCANNED_GLOBS) {
		for await (const rel of new Glob(pattern).scan({ cwd: ROOT })) {
			const path = rel.replaceAll("\\", "/");
			if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
			paths.add(path);
		}
	}

	const docs = new Map<string, Doc>();
	for (const path of [...paths].sort()) {
		const text = await Bun.file(`${ROOT}/${path}`).text();
		const suppressed = new Set<number>();
		text.split("\n").forEach((line, index) => {
			if (line.includes("<!-- docs-check: ignore-line -->")) {
				suppressed.add(index + 2);
			}
		});
		docs.set(path, {
			path,
			text,
			masked: maskCode(text),
			anchors: anchorsOf(text),
			suppressed,
		});
	}
	return docs;
}

/** Local links resolve to a file on disk, and `#fragments` to a real anchor. */
async function checkLinks(docs: Map<string, Doc>): Promise<void> {
	for (const doc of docs.values()) {
		const pattern = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		for (const match of doc.masked.matchAll(pattern)) {
			const raw = match[1] ?? "";
			const line = lineOf(doc.masked, match.index ?? 0);
			if (doc.suppressed.has(line)) continue;
			if (isExternal(raw) || raw.startsWith("{") || raw.length === 0) continue;

			const [rawPath, rawFragment] = splitFragment(raw);
			const fragment = decodeURIComponent(rawFragment ?? "").toLowerCase();

			// Same-document anchor.
			if (rawPath === "") {
				if (fragment.length > 0 && !doc.anchors.has(fragment)) {
					report({
						severity: "error",
						file: doc.path,
						line,
						rule: "link/anchor",
						message: `no heading anchor "#${fragment}" in this document`,
					});
				}
				continue;
			}

			const targetPath = raw.startsWith("/")
				? normalize(rawPath)
				: normalize(`${dirname(doc.path)}/${decodeURIComponent(rawPath)}`);

			const exists = await pathExists(targetPath);
			if (!exists) {
				report({
					severity: "error",
					file: doc.path,
					line,
					rule: "link/target",
					message: `link target does not exist: ${rawPath}`,
				});
				continue;
			}

			if (fragment.length === 0) continue;
			const target = docs.get(targetPath);
			if (target === undefined) continue; // Not a scanned Markdown file.
			if (!target.anchors.has(fragment)) {
				report({
					severity: "error",
					file: doc.path,
					line,
					rule: "link/anchor",
					message: `${targetPath} has no anchor "#${fragment}"`,
				});
			}
		}
	}
}

function splitFragment(target: string): [string, string | undefined] {
	const i = target.indexOf("#");
	if (i === -1) return [target, undefined];
	return [target.slice(0, i), target.slice(i + 1)];
}

const existsCache = new Map<string, boolean>();
async function pathExists(relPath: string): Promise<boolean> {
	const cached = existsCache.get(relPath);
	if (cached !== undefined) return cached;
	const absolute = `${ROOT}/${relPath}`;
	let exists = await Bun.file(absolute).exists();
	if (!exists) {
		// Directories are legitimate link targets and are not "files".
		try {
			exists = [...new Glob("*").scanSync({ cwd: absolute })].length >= 0;
		} catch {
			exists = false;
		}
	}
	existsCache.set(relPath, exists);
	return exists;
}

/** Architecture documents must declare status, baseline, and canonical owner. */
async function checkMetadata(docs: Map<string, Doc>): Promise<void> {
	const targets = new Set<string>();
	for (const pattern of METADATA_GLOBS) {
		for await (const rel of new Glob(pattern).scan({ cwd: ROOT })) {
			targets.add(rel.replaceAll("\\", "/"));
		}
	}

	for (const path of [...targets].sort()) {
		const doc = docs.get(path);
		if (doc === undefined) continue;
		const head = doc.text.split("\n").slice(0, 12).join("\n");

		if (!/^#\s+\S/m.test(head)) {
			report({
				severity: "error",
				file: path,
				line: 1,
				rule: "metadata/title",
				message: "no H1 title in the first 12 lines",
			});
		}

		// The decisions/ index is an architecture document; only the ADRs
		// themselves carry decision status.
		const isAdr = /^docs\/architecture\/decisions\/ADR-/.test(path);
		const allowed = isAdr ? ADR_STATUS_WORDS : STATUS_WORDS;
		const status = /^Status:\s*(.+)$/m.exec(head);
		if (status === null) {
			report({
				severity: "error",
				file: path,
				line: 1,
				rule: "metadata/status",
				message: "missing `Status:` line",
			});
		} else {
			const first = (status[1] ?? "").trim().toLowerCase();
			if (!allowed.some((word) => first.startsWith(word))) {
				report({
					severity: "error",
					file: path,
					line: 1,
					rule: "metadata/status",
					message: `Status must start with one of ${allowed.join(" | ")}, got "${status[1]?.trim()}"`,
				});
			}
		}

		if (!/^Baseline:\s*`?[0-9a-f]{7,40}`?/m.test(head)) {
			report({
				severity: "error",
				file: path,
				line: 1,
				rule: "metadata/baseline",
				message: "missing `Baseline:` line with a commit SHA",
			});
		}

		if (!/^Canonical owner:\s*\S/m.test(head)) {
			report({
				severity: "error",
				file: path,
				line: 1,
				rule: "metadata/owner",
				message: "missing `Canonical owner:` line",
			});
		}
	}
}

/**
 * Fences must balance and every Mermaid block must be closed. This proves the
 * document parses, never that the diagram renders — that stays a human step.
 */
function checkFences(docs: Map<string, Doc>): void {
	for (const doc of docs.values()) {
		const lines = doc.text.split("\n");
		let open: { line: number; marker: string; info: string } | undefined;
		let mermaidBlocks = 0;

		for (let i = 0; i < lines.length; i++) {
			const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? "");
			if (match === null) continue;
			const marker = match[1] ?? "";
			const info = (match[2] ?? "").trim();

			if (open === undefined) {
				open = { line: i + 1, marker: marker[0] ?? "`", info };
				if (info.toLowerCase().startsWith("mermaid")) mermaidBlocks += 1;
				continue;
			}
			// A closing fence carries no info string and uses the same marker char.
			if (info.length === 0 && (marker[0] ?? "") === open.marker) {
				open = undefined;
			}
		}

		if (open !== undefined) {
			report({
				severity: "error",
				file: doc.path,
				line: open.line,
				rule: "fence/unbalanced",
				message: `code fence opened here (\`\`\`${open.info}) is never closed`,
			});
		}

		if (mermaidBlocks > 0 && open === undefined) continue;
	}
}

/** Deviation IDs are cited across the docs; a duplicate makes a citation ambiguous. */
async function checkDeviations(docs: Map<string, Doc>): Promise<void> {
	const path = "docs/architecture/deviations.md";
	const doc = docs.get(path);
	if (doc === undefined) {
		report({
			severity: "error",
			file: path,
			rule: "deviations/missing",
			message: "deviation register not found",
		});
		return;
	}

	const seen = new Map<string, number>();
	const lines = doc.text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^\|\s*((?:DEV|NEW)-\d+)\s*\|/.exec(lines[i] ?? "");
		if (match === null) continue;
		const id = match[1] ?? "";
		const first = seen.get(id);
		if (first !== undefined) {
			report({
				severity: "error",
				file: path,
				line: i + 1,
				rule: "deviations/duplicate-id",
				message: `${id} already declared on line ${first}`,
			});
			continue;
		}
		seen.set(id, i + 1);
	}

	// Every DEV brief needs a row, so a closed item cannot vanish silently.
	for await (const rel of new Glob("docs/todo/items/DEV-*.local.md").scan({
		cwd: ROOT,
	})) {
		const id = /(DEV-\d+)/.exec(rel)?.[1];
		if (id !== undefined && !seen.has(id)) {
			report({
				severity: "warn",
				file: path,
				rule: "deviations/inventory",
				message: `${id} has a brief (${rel}) but no row in the register`,
			});
		}
	}
}

/** The floor of documents other documents and the reading paths depend on. */
async function checkInventory(docs: Map<string, Doc>): Promise<void> {
	for (const path of REQUIRED_DOCS) {
		if (!(await pathExists(path))) {
			report({
				severity: "error",
				file: path,
				rule: "inventory/required",
				message: "required document is missing",
			});
		}
	}

	// Every architecture document must be reachable from the architecture index.
	const index = docs.get("docs/architecture/README.md");
	if (index === undefined) return;
	const linked = new Set<string>();
	for (const match of index.masked.matchAll(/\]\(([^)\s#]+)/g)) {
		linked.add(normalize(`docs/architecture/${match[1] ?? ""}`));
	}

	for await (const rel of new Glob("docs/architecture/**/*.md").scan({
		cwd: ROOT,
	})) {
		const path = rel.replaceAll("\\", "/");
		if (path.endsWith("/README.md") || path === "docs/architecture/README.md") {
			continue;
		}
		// Template and checklist are process documents, linked from prose elsewhere.
		if (path.startsWith("docs/architecture/decisions/")) continue;
		if (!linked.has(path)) {
			report({
				severity: "warn",
				file: "docs/architecture/README.md",
				rule: "inventory/unlisted",
				message: `${path} is not linked from the architecture index`,
			});
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
	const args = new Set(Bun.argv.slice(2));
	const warnOnly = args.has("--warn-only");
	const quiet = args.has("--quiet");

	const docs = await loadDocs();
	await checkLinks(docs);
	await checkMetadata(docs);
	checkFences(docs);
	await checkDeviations(docs);
	await checkInventory(docs);

	findings.sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			(a.line ?? 0) - (b.line ?? 0) ||
			a.rule.localeCompare(b.rule),
	);

	for (const finding of findings) {
		const where =
			finding.line === undefined
				? finding.file
				: `${finding.file}:${finding.line}`;
		console.log(
			`${finding.severity === "error" ? "error" : " warn"}  ${where}  [${finding.rule}] ${finding.message}`,
		);
	}

	const errors = findings.filter((f) => f.severity === "error").length;
	const warnings = findings.length - errors;

	if (!quiet) {
		console.log(
			`\ndocs:check — ${docs.size} documents, ${errors} error(s), ${warnings} warning(s)`,
		);
		if (errors > 0 && warnOnly) {
			console.log(
				"warning mode: exiting 0. See docs/architecture/documentation-checklist.md for the gate cutover.",
			);
		}
	}

	return warnOnly || errors === 0 ? 0 : 1;
}

process.exit(await main());
