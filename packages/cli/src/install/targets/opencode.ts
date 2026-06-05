import { join } from "node:path";
import type { AgentGuideLink, Location, McpEntry, Target } from "../target";
import {
	getJsoncValue,
	readJsonc,
	serializeJsonc,
	setJsoncPath,
	type JsoncDoc,
} from "../writers/jsonc";

export const opencodeTarget: Target = {
	id: "opencode",
	label: "opencode",

	configPath(location: Location, cwd: string, homeDir: string): string {
		if (location === "local") return join(cwd, "opencode.jsonc");
		return join(opencodeConfigBase(homeDir), "opencode.jsonc");
	},

	agentGuide(location: Location, cwd: string, homeDir: string): AgentGuideLink {
		return {
			path:
				location === "local"
					? join(cwd, "AGENTS.md")
					: join(opencodeConfigBase(homeDir), "AGENTS.md"),
			source: "file",
		};
	},

	supportsLocation(_location: Location): boolean {
		return true;
	},

	async read(filePath: string): Promise<JsoncDoc> {
		return readJsonc(filePath);
	},

	hasEntry(doc: unknown): boolean {
		const parsed = getJsoncValue(doc as JsoncDoc);
		return !!(parsed.mcp as Record<string, unknown> | undefined)?.astrograph;
	},

	upsert(doc: unknown, entry: McpEntry): JsoncDoc {
		return setJsoncPath(doc as JsoncDoc, ["mcp", "astrograph"], {
			type: "local",
			command: [entry.command, ...entry.args],
			enabled: true,
		});
	},

	remove(doc: unknown): JsoncDoc {
		return setJsoncPath(doc as JsoncDoc, ["mcp", "astrograph"], undefined);
	},

	serialize(doc: unknown): string {
		return serializeJsonc(doc as JsoncDoc);
	},
};

function opencodeConfigBase(homeDir: string): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const configBase =
		xdg ??
		(process.platform === "win32"
			? (process.env.APPDATA ?? join(homeDir, "AppData", "Roaming"))
			: join(homeDir, ".config"));
	return join(configBase, "opencode");
}
