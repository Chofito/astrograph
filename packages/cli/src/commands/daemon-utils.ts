import {
	existsSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { spawn } from "bun";
import { selfCommand } from "../runtime";

export interface DaemonMetadata {
	pid: number;
	startedAt: number;
	root: string;
	mode: "watch";
}

export function getDaemonMetadataPath(root: string): string {
	return `${root}/.astrograph/daemon.json`;
}

export function getDaemonLogPath(root: string): string {
	return `${root}/.astrograph/daemon.log`;
}

/**
 * `daemon.json` is a file on disk, so its contents are input, not a promise.
 * Casting the parse result would let a truncated or hand-edited file flow in as
 * a `DaemonMetadata` and surface later as `pid: undefined` in `status`.
 */
function isDaemonMetadata(value: unknown): value is DaemonMetadata {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.pid === "number" &&
		Number.isInteger(candidate.pid) &&
		typeof candidate.startedAt === "number" &&
		typeof candidate.root === "string" &&
		candidate.mode === "watch"
	);
}

export function readDaemonMetadata(root: string): DaemonMetadata | undefined {
	const path = getDaemonMetadataPath(root);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isDaemonMetadata(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function writeDaemonMetadata(
	root: string,
	metadata: DaemonMetadata,
): void {
	const path = getDaemonMetadataPath(root);
	writeFileSync(path, JSON.stringify(metadata, null, 2), "utf8");
}

export function removeDaemonMetadata(root: string): void {
	const path = getDaemonMetadataPath(root);
	if (existsSync(path)) {
		unlinkSync(path);
	}
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function isDaemonRunning(root: string): boolean {
	const metadata = readDaemonMetadata(root);
	if (metadata === undefined) return false;
	if (!isPidAlive(metadata.pid)) {
		removeDaemonMetadata(root);
		return false;
	}
	return true;
}

export function peekDaemonRunning(root: string): boolean {
	const metadata = readDaemonMetadata(root);
	return metadata !== undefined && isPidAlive(metadata.pid);
}

export function spawnDaemon(root: string): DaemonMetadata {
	const logPath = getDaemonLogPath(root);
	const logFd = openSync(logPath, "a");

	const proc = spawn(daemonCommand(root), {
		stdout: logFd,
		stderr: logFd,
		stdin: "ignore",
	});

	proc.unref();

	const metadata: DaemonMetadata = {
		pid: proc.pid,
		startedAt: Date.now(),
		root,
		mode: "watch",
	};

	writeDaemonMetadata(root, metadata);

	return metadata;
}

export async function stopDaemon(root: string): Promise<boolean> {
	const metadata = readDaemonMetadata(root);
	if (metadata === undefined) return false;

	if (!isPidAlive(metadata.pid)) {
		removeDaemonMetadata(root);
		return false;
	}

	try {
		process.kill(metadata.pid, "SIGTERM");
		if (await waitForExit(metadata.pid, 1500)) {
			removeDaemonMetadata(root);
			return true;
		}
		process.kill(metadata.pid, "SIGKILL");
		const stopped = await waitForExit(metadata.pid, 1000);
		if (stopped) removeDaemonMetadata(root);
		return stopped;
	} catch {
		removeDaemonMetadata(root);
		return false;
	}
}

function daemonCommand(root: string): string[] {
	return selfCommand(["daemon", "--path", root]);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !isPidAlive(pid);
}
