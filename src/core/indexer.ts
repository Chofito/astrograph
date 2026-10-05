import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Config } from "./config";
import { setMeta } from "./db";
import { extract } from "./extract";
import type { Extraction } from "./extract/types";
import { linkReferences } from "./link";
import { initParsers } from "./parser";
import { type ScannedFile, scanFiles } from "./scan";

export interface SyncResult {
	added: number;
	modified: number;
	removed: number;
	unchanged: number;
	failed: number;
	durationMs: number;
}

export interface SyncOptions {
	onProgress?: (done: number, total: number) => void;
}

const BATCH_SIZE = 100;

interface StoredFile {
	id: number;
	size: number;
	mtime: number;
	hash: string;
}

/**
 * Brings the index in line with the working tree. Only files whose size or
 * mtime moved are read; only files whose content hash moved are re-parsed.
 * Each batch is read, parsed, written and dropped before the next one.
 */
export async function syncIndex(
	db: Database,
	root: string,
	config: Config,
	options: SyncOptions = {},
): Promise<SyncResult> {
	const started = performance.now();
	const scanned = scanFiles(root, config);
	const stored = new Map<string, StoredFile>();
	for (const row of db
		.query<StoredFile & { path: string }, []>("SELECT id, path, size, mtime, hash FROM files")
		.all()) {
		stored.set(row.path, row);
	}

	const result: SyncResult = { added: 0, modified: 0, removed: 0, unchanged: 0, failed: 0, durationMs: 0 };
	const seen = new Set(scanned.map((f) => f.path));
	const removedIds = [...stored].filter(([path]) => !seen.has(path)).map(([, row]) => row.id);
	const pending = scanned.filter((file) => {
		const prev = stored.get(file.path);
		const touched = !prev || prev.size !== file.size || prev.mtime !== file.mtime;
		if (!touched) result.unchanged++;
		return touched;
	});

	await initParsers(new Set(pending.map((f) => f.lang)));
	const writer = new Writer(db);
	if (removedIds.length > 0) {
		db.transaction(() => {
			for (const id of removedIds) writer.deleteFile(id);
		})();
		result.removed = removedIds.length;
	}

	for (let i = 0; i < pending.length; i += BATCH_SIZE) {
		const batch = pending.slice(i, i + BATCH_SIZE);
		const sources = await Promise.all(batch.map((file) => readSource(root, file)));
		db.transaction(() => {
			batch.forEach((file, j) => {
				const source = sources[j];
				if (source === undefined) return;
				const prev = stored.get(file.path);
				const hash = Bun.hash(source).toString(16);
				if (prev && prev.hash === hash) {
					writer.touchFile(prev.id, file);
					result.unchanged++;
					return;
				}
				let extraction: Extraction | undefined;
				let error: string | null = null;
				try {
					extraction = extract(file.lang, source);
				} catch (err) {
					error = err instanceof Error ? err.message : String(err);
					result.failed++;
				}
				if (prev) writer.deleteFile(prev.id);
				writer.insertFile(file, hash, countLines(source), error, extraction);
				if (prev) result.modified++;
				else result.added++;
			});
		})();
		options.onProgress?.(Math.min(i + BATCH_SIZE, pending.length), pending.length);
	}

	if (result.added + result.modified + result.removed > 0) linkReferences(db, root);
	setMeta(db, "last_sync", new Date().toISOString());
	result.durationMs = Math.round(performance.now() - started);
	return result;
}

async function readSource(root: string, file: ScannedFile): Promise<string | undefined> {
	try {
		return await Bun.file(join(root, file.path)).text();
	} catch {
		return undefined;
	}
}

function countLines(source: string): number {
	let lines = 1;
	for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) lines++;
	return lines;
}

class Writer {
	private readonly del;
	private readonly touch;
	private readonly file;
	private readonly symbol;
	private readonly ref;
	private readonly imp;

	constructor(db: Database) {
		this.del = db.prepare("DELETE FROM files WHERE id = ?");
		this.touch = db.prepare("UPDATE files SET size = ?, mtime = ? WHERE id = ?");
		this.file = db.prepare(
			"INSERT INTO files (path, lang, size, mtime, hash, lines, error) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
		);
		this.symbol = db.prepare(
			`INSERT INTO symbols (file_id, parent_id, name, qualified_name, kind, exported, start_line, end_line, signature, return_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		);
		this.ref = db.prepare(
			"INSERT INTO refs (file_id, from_id, kind, name, receiver, hints, line) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.imp = db.prepare("INSERT INTO imports (file_id, local, imported, source, reexport) VALUES (?, ?, ?, ?, ?)");
	}

	deleteFile(id: number) {
		this.del.run(id);
	}

	touchFile(id: number, file: ScannedFile) {
		this.touch.run(file.size, file.mtime, id);
	}

	insertFile(file: ScannedFile, hash: string, lines: number, error: string | null, extraction: Extraction | undefined) {
		const { id: fileId } = this.file.get(file.path, file.lang, file.size, file.mtime, hash, lines, error) as {
			id: number;
		};
		if (!extraction) return;
		const ids: number[] = [];
		for (const s of extraction.symbols) {
			const parentId = s.parent === null ? null : (ids[s.parent] ?? null);
			const row = this.symbol.get(
				fileId,
				parentId,
				s.name,
				s.qualifiedName,
				s.kind,
				s.exported ? 1 : 0,
				s.startLine,
				s.endLine,
				s.signature,
				s.returnType ?? null,
			) as { id: number };
			ids.push(row.id);
		}
		for (const r of extraction.refs) {
			const fromId = r.from === null ? null : (ids[r.from] ?? null);
			this.ref.run(fileId, fromId, r.kind, r.name, r.receiver, r.hints ? r.hints.join("\n") : null, r.line);
		}
		for (const i of extraction.imports) {
			this.imp.run(fileId, i.local, i.imported, i.source, i.reexport ? 1 : 0);
		}
	}
}
