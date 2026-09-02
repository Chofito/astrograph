import { FAILURE_MANIFESTS } from "./failure-fixtures";
import type { PipelineManifest } from "./harness";
import { JSTS_MANIFESTS } from "./jsts-fixtures";
import { MIXED_MANIFESTS } from "./mixed-fixtures";
import { phpManifests } from "./php-fixtures";
import { SMOKE_MANIFEST } from "./smoke-fixture";

/**
 * Every production-pipeline fixture that owns a recorded golden.
 *
 * This is the list the updater validates against, which is what makes an
 * unknown fixture id an error rather than a silently created directory. The
 * AG-307 route scripts are deliberately absent: they carry no golden, because
 * each route is compared against a clean index of the same final state rather
 * than against a checked-in expectation.
 */
export async function allPipelineManifests(): Promise<PipelineManifest[]> {
	return [
		SMOKE_MANIFEST,
		...JSTS_MANIFESTS,
		...(await phpManifests()),
		...MIXED_MANIFESTS,
		...FAILURE_MANIFESTS,
	];
}

/** Every known fixture id, sorted — the vocabulary the updater accepts. */
export async function pipelineFixtureIds(): Promise<string[]> {
	return (await allPipelineManifests()).map((manifest) => manifest.id).sort();
}
