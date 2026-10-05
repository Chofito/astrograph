import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import {
	GOLDENS_ROOT,
	goldenPaths,
	requiredGoldenArtifacts,
	requirePipelineGolden,
} from "./goldens";
import { PIPELINE_ROOT } from "./harness";
import { allPipelineManifests, pipelineFixtureIds } from "./manifests";

/**
 * AG-308: the golden-update workflow's guardrails.
 *
 * Every case here is a refusal. The updater is the only writer of a reviewed
 * expectation, so what has to be tested is not that it can write — the goldens
 * in the repository are that evidence — but that it declines to write when
 * nobody said which fixture, when the fixture does not exist, and when
 * "everything" was requested without saying so on purpose.
 *
 * The updater is run as a subprocess rather than imported: it is a script with
 * top-level `process.exit`, and its exit code is part of its contract.
 */

/**
 * Every test in this file runs real indexing — a TypeScript program, tree-sitter
 * parses and a SQLite database per pipeline — so the explicit timeouts below are
 * headroom for a loaded machine, not permission to be slow. Bun's 5 s default
 * left the four-route rows failing on contention alone while they were doing
 * about two seconds of genuine work.
 */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

const UPDATER = `${PIPELINE_ROOT}/update-goldens.ts`;

async function runUpdater(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", UPDATER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("the updater refuses to guess", () => {
	test(
		"no fixture named is a failure, not an update-all",
		async () => {
			const { exitCode, stderr } = await runUpdater([]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("No fixture named");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an unknown fixture id fails and lists the known ones",
		async () => {
			const { exitCode, stderr } = await runUpdater(["not-a-fixture"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown fixture id");
			// The list is how a typo becomes a two-second fix instead of a guess.
			expect(stderr).toContain("jsts-enriched");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"--all without its confirmation fails",
		async () => {
			const { exitCode, stderr } = await runUpdater(["--all"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("--i-reviewed-every-fixture");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"an unknown option fails rather than being ignored",
		async () => {
			const { exitCode, stderr } = await runUpdater(["--force"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown option");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"--list prints exactly the fixtures that own goldens",
		async () => {
			const { exitCode, stdout } = await runUpdater(["--list"]);
			expect(exitCode).toBe(0);
			expect(stdout.trim().split("\n")).toEqual(await pipelineFixtureIds());
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"no route script is updatable",
		async () => {
			// AG-307's rows compare each route individually against a clean-full
			// index of the same final state, not against each other. They therefore
			// have no checked-in golden to update: the clean-full snapshot is
			// computed in the test. Naming a route script has to fail.
			const { exitCode, stderr } = await runUpdater(["jsts-modify"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown fixture id");
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});

describe("normal test runs are read-only", () => {
	test(
		"a missing golden fails the test and writes nothing",
		async () => {
			const paths = goldenPaths("fixture-that-does-not-exist");
			await expect(
				requirePipelineGolden("fixture-that-does-not-exist"),
			).rejects.toThrow("Missing production-pipeline golden");

			// The read path has no update branch: asking for a golden that is not
			// there cannot create it, whatever the environment says.
			expect(existsSync(paths.graph)).toBe(false);
			expect(existsSync(paths.envelopes)).toBe(false);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"no golden directory outlives its fixture",
		async () => {
			// The reverse of the check below, and the one that catches a rename: a
			// leftover `__goldens__/<id>` directory is verified by nothing, so it
			// would sit in the repository looking like evidence forever.
			const known = new Set(await pipelineFixtureIds());
			const onDisk = (await readdir(GOLDENS_ROOT, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();

			expect(onDisk.length).toBeGreaterThan(0);
			expect(onDisk.filter((id) => !known.has(id))).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);

	test(
		"every known fixture has the golden artifacts its manifest requires",
		async () => {
			// Driven from the manifests themselves, not from a duplicated id list:
			// a fixture added without recording its expectation, or a fixture with
			// probes that never wrote `envelopes.json`, fails here as an incomplete
			// change. The message names the missing artifact.
			const missing: string[] = [];
			for (const manifest of await allPipelineManifests()) {
				const required = requiredGoldenArtifacts(manifest);
				if (!existsSync(required.graph)) {
					missing.push(`${manifest.id}: missing graph.json`);
				}
				if (
					required.envelopes !== undefined &&
					!existsSync(required.envelopes)
				) {
					missing.push(`${manifest.id}: missing envelopes.json`);
				}
			}
			expect(missing).toEqual([]);
		},
		PIPELINE_TEST_TIMEOUT_MS,
	);
});
