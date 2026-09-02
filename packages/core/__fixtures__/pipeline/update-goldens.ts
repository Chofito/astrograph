#!/usr/bin/env bun
import { writePipelineGolden } from "./goldens";
import { runCleanPipeline } from "./harness";
import { allPipelineManifests, pipelineFixtureIds } from "./manifests";

/**
 * Record production-pipeline goldens for the fixtures named on the command
 * line (AG-308).
 *
 * ```sh
 * bun packages/core/__fixtures__/pipeline/update-goldens.ts jsts-enriched
 * bun packages/core/__fixtures__/pipeline/update-goldens.ts --list
 * ```
 *
 * ## Why there is no update-all
 *
 * A golden is a reviewed claim about what the product persists. "Update
 * everything" turns a failing suite green in one keystroke and produces a diff
 * nobody can read, which is the failure mode this command exists to prevent:
 * the update is only as trustworthy as the human reading its diff, and a human
 * reads one fixture at a time. Naming the fixtures is therefore mandatory, and
 * `--all` exists only behind `--i-reviewed-every-fixture` so that the intent is
 * recorded in the shell history of whoever did it.
 *
 * Nothing here is reachable from `bun test`. The read path in `goldens.ts` has
 * no update branch at all, so a test run cannot rewrite its own expectation
 * however the environment is configured.
 */

const USAGE = `Record production-pipeline goldens.

Usage:
  bun packages/core/__fixtures__/pipeline/update-goldens.ts <fixture-id>...
  bun packages/core/__fixtures__/pipeline/update-goldens.ts --list
  bun packages/core/__fixtures__/pipeline/update-goldens.ts --all --i-reviewed-every-fixture

Every fixture id must be named explicitly. Run --list to see them.`;

const ALL_FLAG = "--all";
const ALL_CONFIRMATION = "--i-reviewed-every-fixture";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}

const known = await pipelineFixtureIds();

if (args.includes("--list")) {
	for (const id of known) console.log(id);
	process.exit(0);
}

if (args.length === 0) {
	fail(
		`No fixture named. Updating every golden by default is exactly the mistake this refuses to make.\n\n${USAGE}`,
	);
}

let targets: string[];

if (args.includes(ALL_FLAG)) {
	if (!args.includes(ALL_CONFIRMATION)) {
		fail(
			`${ALL_FLAG} requires ${ALL_CONFIRMATION}. Rewriting every reviewed expectation at once needs to be a deliberate, recorded act.`,
		);
	}
	const extra = args.filter(
		(arg) => arg !== ALL_FLAG && arg !== ALL_CONFIRMATION,
	);
	if (extra.length > 0) {
		fail(`${ALL_FLAG} takes no fixture ids; got: ${extra.join(", ")}`);
	}
	targets = known;
} else {
	const unknownFlags = args.filter((arg) => arg.startsWith("-"));
	if (unknownFlags.length > 0) {
		fail(`Unknown option(s): ${unknownFlags.join(", ")}\n\n${USAGE}`);
	}

	const unknown = args.filter((arg) => !known.includes(arg));
	if (unknown.length > 0) {
		fail(
			`Unknown fixture id(s): ${unknown.join(", ")}\nKnown ids:\n${known
				.map((id) => `  ${id}`)
				.join("\n")}`,
		);
	}
	// De-duplicated, so naming a fixture twice does not index it twice.
	targets = [...new Set(args)];
}

const manifests = await allPipelineManifests();
const written: string[] = [];

for (const id of targets) {
	const manifest = manifests.find((candidate) => candidate.id === id);
	// Unreachable: `targets` is validated against the same list. Kept so a future
	// refactor that decouples the two fails loudly instead of skipping silently.
	if (manifest === undefined) fail(`No manifest for fixture "${id}"`);

	const snapshot = await runCleanPipeline(manifest);
	const paths = await writePipelineGolden(id, snapshot);
	written.push(...paths);
	for (const path of paths) console.log(`wrote ${path}`);
}

console.log(
	`\n${written.length} file(s) written for ${targets.length} fixture(s). Review every diff before committing.`,
);
