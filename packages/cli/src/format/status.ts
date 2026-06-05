import type { StatusOutput, ToolResult } from "@astrograph/core";
import { footer } from "./footer";
import { style, symbols } from "./style";

export interface DaemonStatus {
	running: boolean;
	pid?: number;
	startedAt?: number;
}

export function formatStatus(
	result: ToolResult<StatusOutput>,
	daemon?: DaemonStatus,
): string {
	const lines = [
		style.header("Astrograph Status"),
		`${symbols.bullet} files      ${style.num(result.data.fileCount)}`,
		`${symbols.bullet} nodes      ${style.num(result.data.nodeCount)}`,
		`${symbols.bullet} edges      ${style.num(result.data.edgeCount)}`,
		`${symbols.bullet} coverage   ${style.num(result.data.coverage.resolved)}/${style.num(result.data.coverage.total)} resolved (${result.data.coverage.parsed} parsed, ${result.data.coverage.pending} pending)`,
		`${symbols.bullet} backend    ${style.dim(result.data.backend)}`,
		`${symbols.bullet} journal    ${style.dim(result.data.journalMode)}`,
	];

	if (daemon) {
		if (daemon.running && daemon.pid !== undefined) {
			const since = daemon.startedAt
				? formatSince(daemon.startedAt)
				: "unknown";
			lines.push(
				`${symbols.bullet} daemon     running (pid ${style.num(daemon.pid)}, since ${style.dim(since)})`,
			);
		} else {
			lines.push(`${symbols.bullet} daemon     ${style.dim("not running")}`);
		}
	}

	if (
		result.data.pendingSync !== undefined &&
		result.data.pendingSync.length > 0
	) {
		lines.push(
			`${symbols.bullet} pending    ${result.data.pendingSync.join(", ")}`,
		);
	}
	lines.push(footer(result.meta));
	return lines.join("\n");
}

function formatSince(startedAt: number): string {
	const elapsedSeconds = Math.max(
		0,
		Math.floor((Date.now() - startedAt) / 1000),
	);
	if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours}h`;
	return `${Math.floor(elapsedHours / 24)}d`;
}
