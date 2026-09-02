import type { FixtureFiles, PipelineManifest } from "./harness";
import {
	calleesProbe,
	callersProbe,
	filesProbe,
	impactProbe,
	nodeProbe,
	searchProbe,
	statusProbe,
	traceProbe,
} from "./probes";

/**
 * AG-303: one JS/TS project, indexed twice — enriched and Pass-A-only.
 *
 * The two fixtures share byte-identical sources on purpose. The only difference
 * between their goldens is what the *shipped configuration* can prove, so a
 * reviewer comparing them sees exactly what the TypeScript enricher adds and
 * exactly what a Pass-A-only index still honestly offers.
 *
 * Every file exists for one row of the required matrix:
 *
 * | File | What it is evidence for |
 * |---|---|
 * | `src/core/compute.ts` | TypeScript ownership; the declarations everything else resolves to. |
 * | `src/core/index.ts` | Barrel re-export: multi-file resolution through a second hop. |
 * | `src/app.ts` | Calls and instantiation across files, plus an unresolvable module target. |
 * | `src/legacy.js` | JavaScript ownership by the same backend, resolving into TypeScript. |
 * | `src/merged.ts` | A merged function/namespace declaration — the ambiguity case. |
 * | `src/widget.tsx` | TSX ownership and a component that calls into the core. |
 * | `src/unprovable.ts` | The two constructs that must stay `unresolved`: a call on an `any` receiver and a non-literal `import()`. |
 *
 * `node:path` is imported but never installed: the temporary project has no
 * `node_modules`, so that import is the fixture's unprovable target. It is
 * deliberately not stubbed — an unresolved module is the honest outcome for a
 * project whose dependencies are not present, and the oracle records it as such
 * instead of hiding it. A *resolved* external target — one the compiler can see
 * but the project does not own — is the separate
 * {@link JSTS_EXTERNAL_PACKAGE_MANIFEST}, because it needs an installed package
 * and that changes what every other row in this project looks like.
 */
const JSTS_SOURCES: FixtureFiles = {
	"src/core/compute.ts": `export function compute(base: number): number {
	return base + 1;
}

export class Registry {
	private total = 0;

	register(value: number): number {
		this.total = compute(value);
		return this.total;
	}
}
`,
	"src/core/index.ts": `export { compute, Registry } from "./compute";
`,
	"src/app.ts": `import { join } from "node:path";
import { compute, Registry } from "./core";

export function run(): number {
	const registry = new Registry();
	return registry.register(compute(1));
}

export function describePath(): string {
	return join("a", "b");
}
`,
	"src/legacy.js": `import { compute } from "./core/compute";

export function runLegacy() {
	return compute(2);
}
`,
	"src/merged.ts": `function merged() {
	return 1;
}

namespace merged {
	export const tag = "ns";
}

export function readTag(): string {
	return merged.tag;
}
`,
	"src/unprovable.ts": `/**
 * Two relations the compiler cannot prove, and the graph must not pretend to.
 *
 * \`any\` erases the receiver's type, so \`target.whatever()\` has no
 * declaration to point at; a non-literal \`import()\` has no module specifier
 * to resolve. Both are recorded with the text the source wrote and no target,
 * which is a different and weaker claim than \`external\` — where the target is
 * known and merely lives outside the project.
 */
export function callThroughAny(target: any): unknown {
	return target.whatever();
}

export async function loadByName(name: string): Promise<unknown> {
	return import(name);
}
`,
	"src/widget.tsx": `import { compute } from "./core";

export function Widget(props: { base: number }) {
	return <span>{compute(props.base)}</span>;
}
`,
};

/**
 * The probes both fixtures pin.
 *
 * Identical in both modes, again on purpose: the same question asked of an
 * enriched and a Pass-A-only index must produce two *honest* answers, and the
 * only way to review that is to see both envelopes for the same probe name.
 * `callers:compute` is the one that matters most — Pass-A-only cannot answer it
 * and has to say so rather than returning an empty list under a clean banner.
 */
const JSTS_PROBES = [
	searchProbe("compute"),
	callersProbe("compute"),
	calleesProbe("run"),
	impactProbe("compute"),
	nodeProbe("Registry"),
	traceProbe("run", "compute"),
	filesProbe(),
	statusProbe(),
];

export const JSTS_ENRICHED_MANIFEST: PipelineManifest = {
	id: "jsts-enriched",
	description:
		"TS, JS and TSX sources through the shipped enriched TypeScript backend: barrel resolution, calls, instantiation, ambiguity and an unresolved module target.",
	modes: { typescript: "enriched", php: "disabled" },
	files: JSTS_SOURCES,
	probes: JSTS_PROBES,
};

export const JSTS_PASS_A_MANIFEST: PipelineManifest = {
	id: "jsts-pass-a-only",
	description:
		"The same sources with `backends.typescript.enricher = false`: structural containment only, and query envelopes that say so.",
	modes: { typescript: "pass-a-only", php: "disabled" },
	files: JSTS_SOURCES,
	probes: JSTS_PROBES,
};

/**
 * An installed dependency, so an external *node* is persisted.
 *
 * The distinction this fixture exists for: `node:path` in the project above is
 * a target the compiler cannot see at all, and it survives only as an edge with
 * a textual name. A package inside `node_modules` is a target the compiler
 * resolves to a real declaration the project does not own — and the pipeline
 * persists a node for it, with `isExternal: true` and a path relative to the
 * project root.
 *
 * Both halves of that are load-bearing. `isPersistableExternalNode` keeps an
 * external node only when its path lies inside the project root, which is why a
 * `lib.d.ts` declaration from the compiler's own installation never reaches the
 * database — and why this fixture's node id is identical on every machine
 * instead of encoding somebody's toolchain path.
 *
 * `node_modules/` is in the scanner's hard-exclude list, so the package is
 * never indexed as project content: exactly one file is owned here.
 */
export const JSTS_EXTERNAL_PACKAGE_MANIFEST: PipelineManifest = {
	id: "jsts-external-package",
	description:
		"An import from an installed package: the external declaration is persisted as an external node with a root-relative path, and the relation resolves to it as `external`.",
	modes: { typescript: "enriched", php: "disabled" },
	files: {
		"node_modules/tiny-lib/package.json": `{
	"name": "tiny-lib",
	"version": "1.0.0",
	"main": "index.js",
	"types": "index.d.ts"
}
`,
		"node_modules/tiny-lib/index.d.ts":
			"export declare function tinyHelper(value: number): number;\n",
		"node_modules/tiny-lib/index.js":
			"export function tinyHelper(value) {\n\treturn value;\n}\n",
		"src/app.ts": `import { tinyHelper } from "tiny-lib";

export function run(): number {
	return tinyHelper(1);
}
`,
	},
	probes: [
		searchProbe("tinyHelper"),
		calleesProbe("run"),
		callersProbe("tinyHelper"),
		filesProbe(),
		statusProbe(),
	],
};

export const JSTS_MANIFESTS = [
	JSTS_ENRICHED_MANIFEST,
	JSTS_EXTERNAL_PACKAGE_MANIFEST,
	JSTS_PASS_A_MANIFEST,
] as const;
