import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	INVALID_CONFIGURATION_FIXTURES,
	VALID_CONFIGURATION_FIXTURES,
} from "../../../core/__fixtures__/configuration";
import {
	InvalidMcpConfigError,
	InvalidMcpConfigJsonError,
	loadConfig,
	ProjectSession,
} from "../project";
import { callTool } from "../server";
import { createTools, type McpToolDefinition } from "../tools";

describe("MCP project configuration", () => {
	for (const fixture of VALID_CONFIGURATION_FIXTURES) {
		test(`uses core defaults for ${fixture.name}`, async () => {
			await withConfig(JSON.stringify(fixture.input), async (root) => {
				expect(await loadConfig(root)).toEqual(fixture.config);
			});
		});
	}

	for (const fixture of INVALID_CONFIGURATION_FIXTURES) {
		test(`preserves core diagnostics for ${fixture.name}`, async () => {
			await withConfig(JSON.stringify(fixture.input), async (root) => {
				await expect(loadConfig(root)).rejects.toMatchObject({
					diagnostics: fixture.diagnostics,
				});
			});
		});
	}

	test("distinguishes invalid JSON from semantic configuration", async () => {
		await withConfig("{", async (root) => {
			await expect(loadConfig(root)).rejects.toBeInstanceOf(
				InvalidMcpConfigJsonError,
			);
		});
	});

	test("formats semantic facts for MCP tool text", async () => {
		const fixture = INVALID_CONFIGURATION_FIXTURES[0];
		if (fixture === undefined) throw new Error("missing semantic fixture");
		const expected = fixture.diagnostics[0];
		if (expected === undefined) {
			throw new Error("semantic fixture has no diagnostics");
		}
		await withConfig(JSON.stringify(fixture.input), async (root) => {
			try {
				await loadConfig(root);
				throw new Error("expected configuration failure");
			} catch (error) {
				if (!(error instanceof InvalidMcpConfigError)) throw error;
				expect(error.message).toContain("[UNKNOWN_CONFIG_KEY] /kinds:");
				expect(error.message).toContain(expected.message);
			}
		});
	});

	test("returns semantic facts through the MCP error envelope", async () => {
		const fixture = INVALID_CONFIGURATION_FIXTURES[0];
		if (fixture === undefined) throw new Error("missing semantic fixture");
		const expected = fixture.diagnostics[0];
		if (expected === undefined) {
			throw new Error("semantic fixture has no diagnostics");
		}
		await withConfig(JSON.stringify(fixture.input), async (root) => {
			const session = new ProjectSession({ cwd: root, watch: false });
			const tools = new Map<string, McpToolDefinition>(
				createTools(session).map((tool): [string, McpToolDefinition] => [
					tool.name,
					tool,
				]),
			);
			const result = await callTool(tools, "astrograph_status", {});
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected MCP text error");
			expect(result.isError).toBe(true);
			expect(content.text).toContain("[UNKNOWN_CONFIG_KEY] /kinds:");
			expect(content.text).toContain(expected.message);
		});
	});
});

async function withConfig(
	contents: string,
	fn: (root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(`${tmpdir()}/astrograph-mcp-config-`);
	try {
		await mkdir(`${root}/.astrograph`, { recursive: true });
		await writeFile(`${root}/.astrograph/config.json`, contents, "utf8");
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
