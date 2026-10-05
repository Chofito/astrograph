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
 * Four projects: three STEP 3 clusters plus the isolated DEV-010 pin:
 *
 * | Fixture | Matrix rows |
 * |---|---|
 * | `php-calls-*` | Receiver buckets STEP 3 promises, unresolved and dynamic calls, vendor/external parents, case-insensitive lookup. |
 * | `php-heritage-enriched` | Classes, interfaces, inheritance, plain/aliased/grouped/absolute imports, a missing generated class. |
 * | `php-types-enriched` | Imported types in parameter, promoted-property, property and return positions; scalars that must produce nothing. |
 * | `php-grouped-use-mixed` | DEV-010 AS-IS: mixed grouped `use` contaminates the type alias map. |
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

/**
 * DEV-010: mixed grouped-use as PHP actually writes it.
 *
 * Correct PHP: only `Bar` is a class import. `function baz` and `const QUX`
 * live in other symbol tables and must never enter class or type resolution.
 *
 * Astrograph AS-IS: `collectUseDeclaration` copies every grouped clause into
 * the type alias map, so `baz` and `QUX` become class aliases for
 * `Vendor\\baz` and `Vendor\\QUX`. `new baz()` and `QUX $flag` are then treated
 * as class references. This fixture exists so that repairing DEV-010 has to
 * change a reviewed production golden rather than slipping through as a
 * silent alias-table edit.
 */
const GROUPED_USE_BAR_SOURCE = `<?php

namespace Vendor;

class Bar
{
    public function run(): void
    {
    }
}
`;

const GROUPED_USE_CONSUMER_SOURCE = `<?php

namespace App;

// Correct PHP: only Bar is a class import. function baz and const QUX must
// not enter class/type resolution. Astrograph AS-IS (DEV-010) copies every
// grouped clause into the type alias map, so new baz() and QUX \$flag become
// class-shaped external relations. Fixing DEV-010 must change this golden.
use Vendor\\{Bar, function baz, const QUX};

class Consumer
{
    public function __construct(private readonly QUX $flag)
    {
    }

    public function make(): Bar
    {
        new baz();
        return new Bar();
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
		{
			id: "php-grouped-use-mixed",
			description:
				"DEV-010 AS-IS: mixed grouped use (`use Vendor\\{Bar, function baz, const QUX}`) contaminates the type alias map so function and const clauses participate in class resolution. Correct PHP would not. Repairing DEV-010 must change this golden.",
			modes: { php: "enriched", typescript: "disabled" },
			files: {
				"src/Bar.php": GROUPED_USE_BAR_SOURCE,
				"src/Consumer.php": GROUPED_USE_CONSUMER_SOURCE,
			},
			probes: [
				searchProbe("Bar"),
				nodeProbe("Consumer"),
				calleesProbe("make"),
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
