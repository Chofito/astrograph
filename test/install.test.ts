import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentGuide, isAstrographGuide } from "../src/cli/install/agent-guide";

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
