import type { PipelineManifest } from "./harness";
import { callersProbe, filesProbe, searchProbe } from "./probes";

/**
 * The AG-302 smoke fixture: the smallest project that proves the harness runs
 * the production pipeline end to end and that its comparison actually fails.
 *
 * Two files, one cross-file call. That is the minimum that exercises registry
 * routing, Pass A, the enricher's cross-file resolution through persisted rows,
 * SQLite retirement bookkeeping and a query envelope — while staying small
 * enough that its golden can be read in full during review.
 */
export const SMOKE_MANIFEST: PipelineManifest = {
	id: "smoke",
	description:
		"Two TypeScript files with one cross-file call: the harness reaches registry, Indexer, SQLite and GraphQueries.",
	modes: { typescript: "enriched", php: "disabled" },
	files: {
		"src/target.ts": "export function target(): number {\n\treturn 1;\n}\n",
		"src/caller.ts":
			'import { target } from "./target";\n\nexport function caller(): number {\n\treturn target();\n}\n',
	},
	probes: [searchProbe("target"), callersProbe("target"), filesProbe()],
};
