import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentGuide, isAstrographGuide } from "../src/cli/install/agent-guide";
import { claudeTarget } from "../src/cli/install/targets/claude";
import { codexTarget } from "../src/cli/install/targets/codex";

const root = mkdtempSync(join(tmpdir(), "astrograph-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OLD_GUIDE = "---\nname: astrograph\ndescription: an older release\n---\n\n# Astrograph (old)\n";

describe("agent guide install", () => {
	test("recognizes Astrograph guides by their frontmatter", () => {
		expect(isAstrographGuide(OLD_GUIDE)).toBe(true);
		expect(isAstrographGuide("# My own AGENTS.md\nname: astrograph\n")).toBe(false);
	});

	test("installs a missing guide", async () => {
		const dir = join(root, "fresh", "skills", "astrograph");
		const result = await installAgentGuide({ path: dir, source: "directory" });
		expect(result.action).toBe("installed");
		expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("astrograph_outline");
	});

	test("upgrades a guide written by an older release", async () => {
		const dir = join(root, "old", "skills", "astrograph");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), OLD_GUIDE);
		const result = await installAgentGuide({ path: dir, source: "directory" });
		expect(result.action).toBe("updated");
		expect(readFileSync(join(dir, "SKILL.md"), "utf8")).not.toContain("(old)");
		expect((await installAgentGuide({ path: dir, source: "directory" })).action).toBe("unchanged");
	});

	test("never overwrites a file that is not an Astrograph guide", async () => {
		const file = join(root, "AGENTS.md");
		writeFileSync(file, "# My rules\nAlways use tabs.\n");
		const result = await installAgentGuide({ path: file, source: "file" });
		expect(result.action).toBe("skipped");
		expect(readFileSync(file, "utf8")).toBe("# My rules\nAlways use tabs.\n");
	});
});

describe("host config locations", () => {
	const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
	afterAll(() => {
		for (const [key, value] of [
			["CLAUDE_CONFIG_DIR", saved.claude],
			["CODEX_HOME", saved.codex],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test("default to the home directory", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CODEX_HOME;
		expect(claudeTarget.configPath("global", "/p", "/h")).toBe(join("/h", ".claude.json"));
		expect(claudeTarget.agentGuide?.("global", "/p", "/h")?.path).toBe(join("/h", ".claude", "skills", "astrograph"));
		expect(codexTarget.configPath("global", "/p", "/h")).toBe(join("/h", ".codex", "config.toml"));
	});

	test("follow CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
		process.env.CLAUDE_CONFIG_DIR = "/h/.claude-work";
		process.env.CODEX_HOME = "/h/codex-work";
		expect(claudeTarget.configPath("global", "/p", "/h")).toBe(join("/h/.claude-work", ".claude.json"));
		expect(claudeTarget.agentGuide?.("global", "/p", "/h")?.path).toBe(join("/h/.claude-work", "skills", "astrograph"));
		expect(claudeTarget.configPath("local", "/p", "/h")).toBe(join("/p", ".mcp.json"));
		expect(codexTarget.configPath("global", "/p", "/h")).toBe(join("/h/codex-work", "config.toml"));
		expect(codexTarget.agentGuide?.("global", "/p", "/h")?.path).toBe(join("/h/codex-work", "skills", "astrograph"));
	});
});
