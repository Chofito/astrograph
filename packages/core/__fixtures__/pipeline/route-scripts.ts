import { callersProbe, filesProbe, searchProbe, statusProbe } from "./probes";
import type { MutationScript } from "./routes";

/**
 * The AG-307 mutation matrix, as data.
 *
 * Every row names one change a real project undergoes, and every row is run
 * through all four routes. The sources are the smallest thing that still holds
 * a *cross-file relation*: a mutation matrix over files with no relations
 * between them would converge trivially, because retirement and re-resolution —
 * the two places these routes actually differ — would have nothing to do.
 */

const TS_TARGET = `export function target(): number {
	return 1;
}
`;

const TS_TARGET_EDITED = `export function target(): number {
	return 2;
}

export function extra(): number {
	return 3;
}
`;

const TS_CALLER = `import { target } from "./target";

export function caller(): number {
	return target();
}
`;

/** The caller after `src/target.ts` is renamed to `src/renamed.ts`. */
const TS_CALLER_RENAMED = `import { target } from "./renamed";

export function caller(): number {
	return target();
}
`;

/** Padded past the tight limit below, and still valid TypeScript. */
const TS_TARGET_OVERSIZED = `${TS_TARGET}// ${"pad ".repeat(200)}
`;

const PHP_TARGET = `<?php

namespace App;

class Target
{
    public function run(): void
    {
    }
}
`;

const PHP_TARGET_EDITED = `<?php

namespace App;

class Target
{
    public function run(): void
    {
    }

    public function added(): void
    {
    }
}
`;

const PHP_CALLER = `<?php

namespace App;

class Caller
{
    public function __construct(private readonly Target $target)
    {
    }

    public function go(): void
    {
        $this->target->run();
    }
}
`;

const TS_FILES = {
	"src/target.ts": TS_TARGET,
	"src/caller.ts": TS_CALLER,
};

const PHP_FILES = {
	"src/Target.php": PHP_TARGET,
	"src/Caller.php": PHP_CALLER,
};

const MIXED_FILES = { ...TS_FILES, ...PHP_FILES };

/** Between the two file sizes: the target is out, the caller stays in. */
const TIGHT_LIMIT = 256;
const LOOSE_LIMIT = 1_000_000;

const JSTS_PROBES = [
	searchProbe("target"),
	callersProbe("target"),
	filesProbe(),
	statusProbe(),
];

const PHP_PROBES = [
	searchProbe("run"),
	callersProbe("run"),
	filesProbe(),
	statusProbe(),
];

const MIXED_PROBES = [
	searchProbe("target"),
	searchProbe("run"),
	callersProbe("target"),
	callersProbe("run"),
	filesProbe(),
	statusProbe(),
];

export const ROUTE_SCRIPTS: readonly MutationScript[] = [
	{
		id: "jsts-add",
		description: "A new file appears and becomes a resolvable target.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		mutations: [
			{
				write: "src/second.ts",
				content:
					'import { target } from "./target";\n\nexport function second(): number {\n\treturn target();\n}\n',
			},
		],
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-modify",
		description:
			"An existing file gains a declaration; its referrer must be re-resolved, not left pointing at the old node set.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		mutations: [{ write: "src/target.ts", content: TS_TARGET_EDITED }],
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-delete",
		description:
			"The target of a resolved call is deleted: the relation must be demoted, not dropped.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		mutations: [{ delete: "src/target.ts" }],
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-rename",
		description:
			"A rename is an unlink plus an add on two paths, and the importer follows it.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		mutations: [
			{ delete: "src/target.ts" },
			{ write: "src/renamed.ts", content: TS_TARGET },
			{ write: "src/caller.ts", content: TS_CALLER_RENAMED },
		],
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-eligible-to-oversized",
		description:
			"A file grows past the size limit while an incoming relation points at it.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		config: { maxFileSizeBytes: LOOSE_LIMIT },
		mutations: [{ write: "src/target.ts", content: TS_TARGET_OVERSIZED }],
		finalConfig: { maxFileSizeBytes: TIGHT_LIMIT },
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-oversized-to-eligible",
		description: "The same file crossing the boundary in the other direction.",
		files: { ...TS_FILES, "src/target.ts": TS_TARGET_OVERSIZED },
		modes: { typescript: "enriched", php: "disabled" },
		config: { maxFileSizeBytes: TIGHT_LIMIT },
		mutations: [{ write: "src/target.ts", content: TS_TARGET }],
		finalConfig: { maxFileSizeBytes: LOOSE_LIMIT },
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-exclude-added",
		description:
			"An exclude glob removes a file from the project without deleting it from disk.",
		files: { ...TS_FILES, "vendor/vendored.ts": TS_TARGET },
		modes: { typescript: "enriched", php: "disabled" },
		finalConfig: { exclude: ["vendor/**"] },
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-include-narrowed",
		description:
			"An `include` list replaces the registry-derived scan glob, so a file the project still contains stops being part of it.",
		files: { ...TS_FILES, "extra/helper.ts": TS_TARGET },
		modes: { typescript: "enriched", php: "disabled" },
		// Distinct from `jsts-exclude-added`: an exclude subtracts from the default
		// glob, while an include replaces it. The two reach the same membership by
		// different code paths (`glob.ts` chooses `opts.include ?? defaultInclude`
		// before applying excludes), and only one of them was covered.
		finalConfig: { include: ["src/**/*.ts"] },
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-pass-a-only-modify",
		description:
			"The same edit under a Pass-A-only configuration: fewer facts, identical convergence obligation.",
		files: TS_FILES,
		modes: { typescript: "pass-a-only", php: "disabled" },
		mutations: [{ write: "src/target.ts", content: TS_TARGET_EDITED }],
		probes: JSTS_PROBES,
	},
	{
		id: "jsts-enricher-enabled",
		description:
			"Turning the enricher on over an existing Pass-A-only index must produce the enriched graph, not a mixture.",
		files: TS_FILES,
		modes: { typescript: "pass-a-only", php: "disabled" },
		finalModes: { typescript: "enriched", php: "disabled" },
		probes: JSTS_PROBES,
	},
	{
		id: "php-add",
		description: "A new PHP class becomes a resolvable receiver type.",
		files: PHP_FILES,
		modes: { typescript: "disabled", php: "enriched" },
		mutations: [
			{
				write: "src/Second.php",
				content: `<?php

namespace App;

class Second
{
    public function __construct(private readonly Target $target)
    {
    }

    public function go(): void
    {
        $this->target->run();
    }
}
`,
			},
		],
		probes: PHP_PROBES,
	},
	{
		id: "php-modify",
		description:
			"A PHP class gains a method; the name index and every referrer must agree afterwards.",
		files: PHP_FILES,
		modes: { typescript: "disabled", php: "enriched" },
		mutations: [{ write: "src/Target.php", content: PHP_TARGET_EDITED }],
		probes: PHP_PROBES,
	},
	{
		id: "php-delete",
		description:
			"The receiver class is deleted: the call must fall back to unresolved, in every route.",
		files: PHP_FILES,
		modes: { typescript: "disabled", php: "enriched" },
		mutations: [{ delete: "src/Target.php" }],
		probes: PHP_PROBES,
	},
	{
		id: "php-pass-a-only-modify",
		description:
			"A PHP edit under a Pass-A-only configuration: no receiver resolution to redo, and the same convergence obligation.",
		files: PHP_FILES,
		modes: { typescript: "disabled", php: "pass-a-only" },
		mutations: [{ write: "src/Target.php", content: PHP_TARGET_EDITED }],
		probes: PHP_PROBES,
	},
	{
		id: "jsts-interrupted-then-modified",
		description:
			"An aborted first pass, a reopen with a working backend, and then an ordinary edit: recovery is held to the clean-index expectation on every route.",
		files: TS_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		interruptedOn: ["src/target.ts"],
		mutations: [{ write: "src/target.ts", content: TS_TARGET_EDITED }],
		probes: JSTS_PROBES,
	},
	{
		id: "mixed-modify-both",
		description:
			"One edit per language in a single batch: neither backend may re-resolve the other's files.",
		files: MIXED_FILES,
		modes: { typescript: "enriched", php: "enriched" },
		mutations: [
			{ write: "src/target.ts", content: TS_TARGET_EDITED },
			{ write: "src/Target.php", content: PHP_TARGET_EDITED },
		],
		probes: MIXED_PROBES,
	},
	{
		id: "mixed-backend-disabled",
		description:
			"PHP is switched off over a mixed index; only PHP-owned facts may disappear.",
		files: MIXED_FILES,
		modes: { typescript: "enriched", php: "enriched" },
		finalModes: { typescript: "enriched", php: "disabled" },
		probes: MIXED_PROBES,
	},
	{
		id: "mixed-backend-enabled",
		description:
			"PHP is switched on over a TypeScript-only index and must reconstruct its whole half.",
		files: MIXED_FILES,
		modes: { typescript: "enriched", php: "disabled" },
		finalModes: { typescript: "enriched", php: "enriched" },
		probes: MIXED_PROBES,
	},
];
