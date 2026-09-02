import { expect } from "bun:test";
import {
	compareSnapshots,
	type Discrepancy,
	formatDiscrepancies,
} from "./compare";
import { requirePipelineGolden } from "./goldens";
import type { PipelineSnapshot } from "./harness";

/**
 * Assert a snapshot against its reviewed golden (AG-302).
 *
 * Two failures, in this order, because they answer different questions. The
 * discrepancy list says *what* diverged and *whose* it is — table, backend,
 * file, field — which is the only readable form when a four-route matrix row
 * breaks. `toEqual` then follows as a backstop: if a difference ever escapes
 * the identity-based comparison, the structural diff still fails the test
 * rather than passing silently.
 */
export async function expectMatchesGolden(
	fixtureId: string,
	snapshot: PipelineSnapshot,
): Promise<void> {
	const golden = await requirePipelineGolden(fixtureId);
	assertNoDiscrepancies(
		compareSnapshots(snapshot, golden),
		`golden "${fixtureId}"`,
	);
	expect(snapshot).toEqual(golden);
}

/**
 * Assert that two snapshots taken through different routes are the same graph
 * (AG-307). `label` names the route being judged against its reference.
 */
export function expectSnapshotsAgree(
	actual: PipelineSnapshot,
	expected: PipelineSnapshot,
	label: string,
): void {
	assertNoDiscrepancies(compareSnapshots(actual, expected), label);
	expect(actual).toEqual(expected);
}

export function assertNoDiscrepancies(
	discrepancies: readonly Discrepancy[],
	label: string,
): void {
	if (discrepancies.length === 0) return;
	throw new Error(
		`${label}: ${discrepancies.length} discrepancy(ies)\n${formatDiscrepancies(
			discrepancies,
		)}`,
	);
}
