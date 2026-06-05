import { Database } from "bun:sqlite";
import type { SqliteStatement, StorageAdapter } from "../../types";

interface BunStatementLike {
	run(...params: unknown[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	};
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface BunSqliteStorageOptions {
	readonly?: boolean;
	create?: boolean;
}

export class BunSqliteStatementAdapter implements SqliteStatement {
	constructor(private readonly statement: unknown) {}

	run(...params: unknown[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	} {
		return this.asStatement().run(...params);
	}

	get(...params: unknown[]): unknown {
		return this.asStatement().get(...params);
	}

	all(...params: unknown[]): unknown[] {
		return this.asStatement().all(...params);
	}

	private asStatement(): BunStatementLike {
		return this.statement as BunStatementLike;
	}
}

export class BunSqliteStorageAdapter implements StorageAdapter {
	private readonly db: Database;
	private isOpen = true;

	constructor(path: string, options: BunSqliteStorageOptions = {}) {
		this.db = new Database(path, {
			readonly: options.readonly ?? false,
			create: options.create ?? true,
		});

		this.pragma("foreign_keys = ON");
		if (!options.readonly) {
			this.pragma("journal_mode = WAL");
			this.pragma("synchronous = NORMAL");
		}
	}

	get open(): boolean {
		return this.isOpen;
	}

	prepare(sql: string): SqliteStatement {
		return new BunSqliteStatementAdapter(this.db.prepare(sql));
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T {
		return this.db.transaction(fn as (...a: unknown[]) => T) as (
			...a: unknown[]
		) => T;
	}

	pragma(s: string, opts?: { simple?: boolean }): unknown {
		const sql = `PRAGMA ${s}`;
		if (!opts?.simple) return this.db.prepare(sql).all();

		const row = this.db.prepare(sql).get();
		if (row === null || typeof row !== "object") return row;

		const values = Object.values(row as Record<string, unknown>);
		return values.length === 1 ? values[0] : row;
	}

	close(): void {
		this.db.close();
		this.isOpen = false;
	}
}

export function openSqliteStorage(
	path: string,
	options?: BunSqliteStorageOptions,
): StorageAdapter {
	return new BunSqliteStorageAdapter(path, options);
}
