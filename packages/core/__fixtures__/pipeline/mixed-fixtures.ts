import type { BackendModes, FixtureFiles, PipelineManifest } from "./harness";
import {
	calleesProbe,
	callersProbe,
	filesProbe,
	nodeProbe,
	searchProbe,
	statusProbe,
} from "./probes";

/**
 * AG-305: one application, two languages, no bridge between them.
 *
 * The fixture is built out of *collisions*. `process` and `invoke` are declared
 * in both languages, and each language contains a relation whose target name
 * exists only in the other one. A backend that resolved by bare name — the
 * easiest wrong implementation, and the one `NEW-004` forbids for 0.1.0 —
 * would turn those into resolved cross-language edges and the fixture would go
 * green while the product started lying.
 *
 * | Path | Owner | Collides with |
 * |---|---|---|
 * | `src/js/handler.ts` | typescript | `process`, `invoke` in PHP |
 * | `src/js/consumer.ts` | typescript | calls `handle`, a PHP-only method name |
 * | `src/php/Handler.php` | php | `process`, `invoke` in TS |
 * | `src/php/Consumer.php` | php | calls `compute`, a TS-only function name |
 */

const MIXED_SOURCES: FixtureFiles = {
	"src/js/handler.ts": `export function process(value: number): number {
	return value + 1;
}

export function invoke(): number {
	return process(1);
}
`,
	"src/js/consumer.ts": `import { invoke } from "./handler";

/**
 * \`handle\` is declared in PHP and nowhere in TypeScript. The call below must
 * stay unresolved: a cross-language name match is not proof of anything.
 */
export function consume(target: { handle(): void }): number {
	target.handle();
	return invoke();
}
`,
	"src/php/Handler.php": `<?php

namespace App;

class Handler
{
    public function process(): void
    {
    }

    public function invoke(): void
    {
        $this->process();
    }

    public function handle(): void
    {
    }
}
`,
	"src/php/Consumer.php": `<?php

namespace App;

class Consumer
{
    public function __construct(private readonly Handler $handler)
    {
    }

    public function run(): void
    {
        $this->handler->invoke();
    }

    /** \`compute\` exists only in TypeScript; this must stay unresolved. */
    public function stray($unknown): void
    {
        $unknown->compute();
    }
}
`,
};

const MIXED_PROBES = [
	// Both languages answer the same name; the payloads must not blend.
	searchProbe("process"),
	searchProbe("invoke"),
	callersProbe("process"),
	calleesProbe("run"),
	nodeProbe("Handler"),
	filesProbe(),
	statusProbe(),
];

function mixedManifest(
	id: string,
	description: string,
	modes: BackendModes,
): PipelineManifest {
	return {
		id,
		description,
		modes,
		files: MIXED_SOURCES,
		probes: MIXED_PROBES,
	};
}

export const MIXED_ENRICHED_MANIFEST = mixedManifest(
	"mixed-enriched",
	"JS/TS and PHP in one project, both enriched: homonymous declarations stay distinct and no bare-name coincidence resolves across languages.",
	{ typescript: "enriched", php: "enriched" },
);

export const MIXED_PHP_PASS_A_MANIFEST = mixedManifest(
	"mixed-php-pass-a-only",
	"The same project with PHP running Pass A only: TypeScript keeps its relations and every PHP relational claim is honestly unsupported.",
	{ typescript: "enriched", php: "pass-a-only" },
);

export const MIXED_TS_PASS_A_MANIFEST = mixedManifest(
	"mixed-ts-pass-a-only",
	"The mirror configuration: PHP enriched, TypeScript Pass A only. Capability reporting must follow ownership, not the other way round.",
	{ typescript: "pass-a-only", php: "enriched" },
);

/**
 * The TypeScript half alone — what disabling PHP must converge to.
 *
 * Not a golden fixture: it exists as the reference the disable tests compare
 * TypeScript-owned facts against. Its `.php` paths are scanned and recorded as
 * unindexed evidence, exactly as they are after PHP is switched off over an
 * existing index, which is what makes the comparison meaningful.
 */
export const MIXED_TS_ONLY_MANIFEST = mixedManifest(
	"mixed-typescript-only",
	"Only the TypeScript backend is enabled. Reference state for what disabling PHP over an existing index must produce.",
	{ typescript: "enriched", php: "disabled" },
);

export const MIXED_MANIFESTS = [
	MIXED_ENRICHED_MANIFEST,
	MIXED_PHP_PASS_A_MANIFEST,
	MIXED_TS_PASS_A_MANIFEST,
] as const;
