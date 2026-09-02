import { mkdir } from "node:fs/promises";
import {
	PIPELINE_ROOT,
	type PipelineSnapshot,
	type ProbeOutcome,
} from "./harness";

/**
 * Reviewed expectations for the production-pipeline fixtures (AG-302, AG-308).
 *
 * Reading is what tests do. Writing is what the updater does, and *only* the
 * updater: a test run that could rewrite its own expectation cannot fail, so
 * there is no `UPDATE_GOLDENS` branch anywhere in this module's read path.
 * `bun packages/core/__fixtures__/pipeline/update-goldens.ts <id>…` is the one
 * way an expectation changes, and it refuses to run without explicit targets.
 */

/** Where every pipeline fixture's expectations live. */
export const GOLDENS_ROOT = `${PIPELINE_ROOT}/__goldens__`;

export interface GoldenPaths {
	/** Persisted graph truth. */
	graph: string;
	/** Probe envelopes, keyed by probe name. */
	envelopes: string;
}

export function goldenPaths(fixtureId: string): GoldenPaths {
	const dir = `${GOLDENS_ROOT}/${fixtureId}`;
	return { graph: `${dir}/graph.json`, envelopes: `${dir}/envelopes.json` };
}

/**
 * Load a fixture's expectation, or `null` when it has never been recorded.
 *
 * A fixture with no probes has no `envelopes.json`; that is not a missing
 * golden, so the envelope map defaults to empty rather than failing.
 */
export async function loadPipelineGolden(
	fixtureId: string,
): Promise<PipelineSnapshot | null> {
	const paths = goldenPaths(fixtureId);
	const graphFile = Bun.file(paths.graph);
	if (!(await graphFile.exists())) return null;

	const graph = (await graphFile.json()) as PipelineSnapshot["graph"];
	const envelopeFile = Bun.file(paths.envelopes);
	const envelopes = (await envelopeFile.exists())
		? ((await envelopeFile.json()) as Record<string, ProbeOutcome>)
		: {};

	return { graph, envelopes };
}

/**
 * Load a fixture's expectation or fail with the exact command that records it.
 *
 * Failing here — rather than silently recording — is the guardrail: a new
 * fixture is red until a human has looked at its graph and its envelopes.
 */
export async function requirePipelineGolden(
	fixtureId: string,
): Promise<PipelineSnapshot> {
	const golden = await loadPipelineGolden(fixtureId);
	if (golden !== null) return golden;
	throw new Error(
		[
			`Missing production-pipeline golden for "${fixtureId}".`,
			`Record it with:`,
			`  bun packages/core/__fixtures__/pipeline/update-goldens.ts ${fixtureId}`,
			`then review ${goldenPaths(fixtureId).graph} before committing.`,
		].join("\n"),
	);
}

/**
 * Write a fixture's expectation. Returns every path written, in order.
 *
 * Deterministic on purpose: two-space indentation, a trailing newline, and key
 * order taken from the oracle's own snapshot shape, so an update produces a
 * reviewable diff instead of a reformatting.
 */
export async function writePipelineGolden(
	fixtureId: string,
	snapshot: PipelineSnapshot,
): Promise<string[]> {
	const paths = goldenPaths(fixtureId);
	await mkdir(`${GOLDENS_ROOT}/${fixtureId}`, { recursive: true });

	const written: string[] = [];
	await Bun.write(paths.graph, serialize(snapshot.graph));
	written.push(paths.graph);

	// A fixture with no probes writes no envelope file, so an empty object never
	// looks like "this fixture asserted its envelopes and they were empty".
	if (Object.keys(snapshot.envelopes).length > 0) {
		await Bun.write(paths.envelopes, serialize(snapshot.envelopes));
		written.push(paths.envelopes);
	}

	return written;
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
