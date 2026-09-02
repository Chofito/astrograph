import {
	type FixtureFiles,
	type PipelineManifest,
	readFixtureTree,
} from "./harness";
import {
	calleesProbe,
	callersProbe,
	filesProbe,
	nodeProbe,
	searchProbe,
	statusProbe,
	traceProbe,
} from "./probes";

/**
 * AG-304: the shipped `.php` backend through the production pipeline, inside
 * the frozen PHP STEP 3 scope.
 *
 * The sources are the *existing* reviewed extractor fixtures, read straight out
 * of `__fixtures__/php/`. Copying them would create two sets of PHP inputs that
 * drift apart, and the difference between the extractor golden and the pipeline
 * golden is exactly what `DEV-014` says has to be observable: same input, and
 * now the persisted, queryable answer next to the extracted one.
 *
 * Three projects, one per matrix cluster:
 *
 * | Fixture | Matrix rows |
 * |---|---|
 * | `php-calls-*` | Receiver buckets STEP 3 promises, unresolved and dynamic calls, vendor/external parents, case-insensitive lookup. |
 * | `php-heritage-enriched` | Classes, interfaces, inheritance, plain/aliased/grouped/absolute imports, a missing generated class. |
 * | `php-types-enriched` | Imported types in parameter, promoted-property, property and return positions; scalars that must produce nothing. |
 *
 * Out of scope by ticket, and therefore absent: Magento XML, DI, plugins,
 * generated-code semantics and `.phtml`.
 */

/**
 * The casing case, which no existing fixture expresses.
 *
 * PHP class names are case-insensitive, so `MIXEDCASE` in a type position must
 * find `MixedCase` — while the node keeps the casing the declaration actually
 * used, because that is what a user reads in a result. A lookup that
 * lower-cased the *display* name would pass a naive resolution test and produce
 * unreadable output.
 */
const CASING_SOURCE = `<?php

namespace App;

class MixedCase
{
    public function doWork(): void
    {
    }
}

class CasingConsumer
{
    public function __construct(private readonly MIXEDCASE $service)
    {
    }

    public function go(): void
    {
        $this->service->doWork();
    }
}
`;

const PHP_CALL_PROBES = [
	searchProbe("run"),
	callersProbe("run"),
	calleesProbe("bucketOne"),
	nodeProbe("Worker"),
	traceProbe("bucketOne", "run"),
	filesProbe(),
	statusProbe(),
];

/**
 * Load the PHP manifests.
 *
 * Asynchronous because the sources live on disk as reviewable `.php` files
 * rather than as string literals inside this module.
 */
export async function phpManifests(): Promise<PipelineManifest[]> {
	const callSources: FixtureFiles = {
		...(await readFixtureTree("../php/calls", { into: "src" })),
		"src/Casing.php": CASING_SOURCE,
	};
	const heritageSources = await readFixtureTree("../php/heritage", {
		into: "src",
	});
	const typeSources = await readFixtureTree("../php/types", { into: "src" });

	return [
		{
			id: "php-calls-enriched",
			description:
				"Receiver-aware PHP calls (promoted, typed, constructor-assigned, interface, parent, static, new), unresolved and dynamic calls, a vendor parent and case-insensitive class lookup.",
			modes: { php: "enriched", typescript: "disabled" },
			files: callSources,
			probes: PHP_CALL_PROBES,
		},
		{
			id: "php-calls-pass-a-only",
			description:
				"The same PHP sources with `backends.php.enricher = false`: declarations and containment only, with envelopes that admit it.",
			modes: { php: "pass-a-only", typescript: "disabled" },
			files: callSources,
			probes: PHP_CALL_PROBES,
		},
		{
			id: "php-heritage-enriched",
			description:
				"PHP inheritance and imports: plain, aliased, grouped and absolute `use`, same-namespace resolution, an interface list and a class that does not exist on disk.",
			modes: { php: "enriched", typescript: "disabled" },
			files: heritageSources,
			probes: [
				searchProbe("Child"),
				nodeProbe("Child"),
				callersProbe("Cleanup"),
				filesProbe(),
				statusProbe(),
			],
		},
		{
			id: "php-types-enriched",
			description:
				"PHP type-position edges for imported types, and the scalar and missing-class cases that must not produce a resolved target.",
			modes: { php: "enriched", typescript: "disabled" },
			files: typeSources,
			probes: [
				searchProbe("Worker"),
				nodeProbe("Worker"),
				calleesProbe("run"),
				filesProbe(),
				statusProbe(),
			],
		},
	];
}

/** The enriched calls fixture, which several invariant tests reach for. */
export async function phpCallsManifest(
	mode: "enriched" | "pass-a-only" = "enriched",
): Promise<PipelineManifest> {
	const id =
		mode === "enriched" ? "php-calls-enriched" : "php-calls-pass-a-only";
	const manifest = (await phpManifests()).find(
		(candidate) => candidate.id === id,
	);
	if (manifest === undefined) throw new Error(`no PHP manifest "${id}"`);
	return manifest;
}
