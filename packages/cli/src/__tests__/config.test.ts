import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	INVALID_CONFIGURATION_FIXTURES,
	VALID_CONFIGURATION_FIXTURES,
} from "../../../core/__fixtures__/configuration";
import {
	InvalidCliConfigError,
	InvalidCliConfigJsonError,
	loadConfig,
} from "../commands/shared";

describe("CLI project configuration", () => {
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
				InvalidCliConfigJsonError,
			);
		});
	});

	test("formats semantic facts for terminal output", async () => {
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
				if (!(error instanceof InvalidCliConfigError)) throw error;
				expect(error.message).toContain("/kinds [UNKNOWN_CONFIG_KEY]");
				expect(error.message).toContain(expected.message);
			}
		});
	});
});

async function withConfig(
	contents: string,
	fn: (root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(`${tmpdir()}/astrograph-cli-config-`);
	try {
		await mkdir(`${root}/.astrograph`, { recursive: true });
		await writeFile(`${root}/.astrograph/config.json`, contents, "utf8");
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
