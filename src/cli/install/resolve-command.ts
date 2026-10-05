import { selfBinaryPath } from "../util";

export interface ResolvedCommand {
	command: string;
	args: string[];
}

/**
 * The command written into agent-host MCP config.
 *
 * When running as a compiled binary we write its absolute path: the installer
 * drops it in `~/.local/bin`, which is frequently absent from the PATH of
 * GUI-launched hosts (Claude Desktop, Cursor.app), so a bare "astrograph"
 * fails with ENOENT there. In dev/linked mode there is no meaningful binary
 * path, so fall back to the bare name.
 */
export function resolveCommand(commandOverride?: string): ResolvedCommand {
	return {
		command: commandOverride ?? selfBinaryPath() ?? "astrograph",
		args: ["serve", "--mcp"],
	};
}
