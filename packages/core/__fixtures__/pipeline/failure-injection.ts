import type { CreateRegistryOptions } from "../../src/extraction";
import {
	createDefaultRegistry,
	LanguageRegistry,
	TreeSitterParser,
	treeSitterLangFromPath,
} from "../../src/extraction";
import type { LanguageBackend, PassAResult } from "../../src/types";

/**
 * Deterministic failure injection for AG-306, at the composition seam and
 * nowhere else.
 *
 * Three of the required failure conditions have no honest trigger from a
 * fixture's source tree: a grammar that will not load, a backend whose parser
 * fails, and an extension that no shipped backend claims *while its backend is
 * enabled*. Each injection below therefore replaces exactly one thing — the
 * registry handed to `openProject` — and leaves the Indexer, SQLite and the
 * query layer untouched, so the persisted evidence is produced by production
 * code paths reacting to a production-shaped failure.
 *
 * `createRegistry` lives on `OpenProjectDependencies`, which no barrel exports.
 * A consumer of `@astrograph/core` cannot reach any of this.
 */

/** An extension the fixture owns but tree-sitter has no grammar for. */
export const GRAMMARLESS_EXTENSION = ".frag";

/**
 * A backend that owns `.frag` with the real Pass A parser.
 *
 * Nothing here simulates the failure: `TreeSitterParser` is the shipped parser,
 * and `treeSitterLangFromPath("x.frag")` genuinely returns nothing, so the
 * `TREE_SITTER_UNAVAILABLE` diagnostic and the file-only node come from the
 * production code path. Mutating the process-global grammar cache — the other
 * way to reach this state — would leak into every other test in the run.
 */
function grammarlessBackend(options: CreateRegistryOptions): LanguageBackend {
	const parser = new TreeSitterParser({
		hasher: options.hasher,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.project === undefined ? {} : { project: options.project }),
	});

	return {
		id: "fixture-grammarless",
		languages: ["fragment"],
		extensions: [GRAMMARLESS_EXTENSION],
		parser,
		// No enricher: Pass A is all this backend has, so `contains` is all it may
		// advertise. The registry enforces that at construction.
		capabilities: { edgeKinds: ["contains"] },
		versionKeys: () => ({ parser: "fixture-1" }),
	};
}

/** The shipped registry plus the grammarless backend. */
export function registryWithGrammarlessBackend(
	options: CreateRegistryOptions,
): LanguageRegistry {
	return new LanguageRegistry([
		...createDefaultRegistry(options).list(),
		grammarlessBackend(options),
	]);
}

/** A structured Pass A failure, as a real backend would report one. */
export interface ParserFailure {
	filePath: string;
	code: "PARSE_ERROR" | "TREE_SITTER_PARSE_ERROR";
	message: string;
}

/**
 * The shipped registry with one backend's Pass A failing for named files.
 *
 * The wrapper is built field by field rather than spread: the shipped backends
 * are classes, and `{ ...backend }` would drop `versionKeys` onto the floor —
 * silently changing the index identity the config hash is built from.
 */
export function registryWithFailingParser(
	backendId: string,
	failures: readonly ParserFailure[],
): (options: CreateRegistryOptions) => LanguageRegistry {
	const byPath = new Map(
		failures.map((failure) => [failure.filePath, failure] as const),
	);

	return (options) =>
		new LanguageRegistry(
			createDefaultRegistry(options)
				.list()
				.map((backend) =>
					backend.id === backendId
						? withFailingParser(backend, byPath)
						: backend,
				),
		);
}

function withFailingParser(
	backend: LanguageBackend,
	failures: ReadonlyMap<string, ParserFailure>,
): LanguageBackend {
	return {
		id: backend.id,
		languages: backend.languages,
		extensions: backend.extensions,
		parser: {
			extractNodes(filePath: string, source: string): PassAResult {
				const failure = failures.get(filePath);
				if (failure === undefined) {
					return backend.parser.extractNodes(filePath, source);
				}
				// Zero nodes and a hard error: the case where a file is owned,
				// eligible and enabled, and the graph still knows nothing about it.
				// The failure this rules out is that state looking successful.
				return {
					nodes: [],
					edges: [],
					errors: [
						{
							message: failure.message,
							filePath,
							severity: "error",
							code: failure.code,
						},
					],
				};
			},
		},
		...(backend.enricher === undefined ? {} : { enricher: backend.enricher }),
		capabilities: backend.capabilities,
		versionKeys: () => backend.versionKeys(),
	};
}

/**
 * The shipped registry with one backend's Pass A *throwing* for named files.
 *
 * Distinct from {@link registryWithFailingParser}, and the difference is the
 * whole point: a backend that returns errors reports a per-file problem, while a
 * backend that throws aborts the pass. The index is then a mixture of two
 * generations, which is what `passState` and `lastPassInterrupted()` exist to
 * make visible — and what AG-307's recovery row re-runs to convergence.
 */
export function registryWithThrowingParser(
	backendId: string,
	filePaths: readonly string[],
): (options: CreateRegistryOptions) => LanguageRegistry {
	const paths = new Set(filePaths);

	return (options) =>
		new LanguageRegistry(
			createDefaultRegistry(options)
				.list()
				.map((backend) => {
					if (backend.id !== backendId) return backend;
					return {
						id: backend.id,
						languages: backend.languages,
						extensions: backend.extensions,
						parser: {
							extractNodes(filePath: string, source: string): PassAResult {
								if (paths.has(filePath)) {
									throw new Error(`injected Pass A crash for ${filePath}`);
								}
								return backend.parser.extractNodes(filePath, source);
							},
						},
						...(backend.enricher === undefined
							? {}
							: { enricher: backend.enricher }),
						capabilities: backend.capabilities,
						versionKeys: () => backend.versionKeys(),
					};
				}),
		);
}

/**
 * The shipped registry with one backend reporting `TREE_SITTER_GRAMMAR_MISSING`
 * for named files.
 *
 * Distinct from {@link registryWithGrammarlessBackend}: that fixture uses an
 * extension tree-sitter does not map, so production emits
 * `TREE_SITTER_UNAVAILABLE`. This one keeps a *recognized* extension (the path
 * maps to a `TreeSitterLang`) and then fails the grammar for that language —
 * the `TREE_SITTER_GRAMMAR_MISSING` branch in `TreeSitterParser.extractNodes`.
 *
 * The process-global grammar cache cannot be the trigger. Marking `typescript`
 * or `php` unavailable would leak into every later test in the same process,
 * and skipping `loadGrammars` is order-dependent once an earlier fixture has
 * already loaded the language. The wrapper therefore reproduces the production
 * file-only result `TreeSitterParser` emits when `createParserFor` returns
 * `undefined` after `treeSitterLangFromPath` has already recognized the path:
 * the file node is minted by the real parser (it is constructed *before* the
 * grammar check), structure is dropped, and the structured code is
 * `TREE_SITTER_GRAMMAR_MISSING`. Nothing here is exported from a barrel.
 */
export function registryWithMissingGrammar(
	backendId: string,
	filePaths: readonly string[],
): (options: CreateRegistryOptions) => LanguageRegistry {
	const paths = new Set(filePaths);

	return (options) =>
		new LanguageRegistry(
			createDefaultRegistry(options)
				.list()
				.map((backend) => {
					if (backend.id !== backendId) return backend;
					return withMissingGrammar(backend, paths);
				}),
		);
}

function withMissingGrammar(
	backend: LanguageBackend,
	paths: ReadonlySet<string>,
): LanguageBackend {
	return {
		id: backend.id,
		languages: backend.languages,
		extensions: backend.extensions,
		parser: {
			extractNodes(filePath: string, source: string): PassAResult {
				if (!paths.has(filePath)) {
					return backend.parser.extractNodes(filePath, source);
				}
				const tsLang = treeSitterLangFromPath(filePath);
				if (tsLang === undefined) {
					throw new Error(
						`TREE_SITTER_GRAMMAR_MISSING injection requires a recognized tree-sitter extension, got ${filePath}`,
					);
				}
				// File-node identity matches the production GRAMMAR_MISSING branch:
				// `TreeSitterParser` constructs the file node before `createParserFor`.
				const produced = backend.parser.extractNodes(filePath, source);
				const fileNode = produced.nodes.find((node) => node.kind === "file");
				if (fileNode === undefined) {
					throw new Error(`Pass A produced no file node for ${filePath}`);
				}
				return {
					nodes: [fileNode],
					edges: [],
					errors: [
						{
							message: `tree-sitter grammar not loaded for ${tsLang}`,
							filePath,
							severity: "warning",
							code: "TREE_SITTER_GRAMMAR_MISSING",
						},
					],
				};
			},
		},
		...(backend.enricher === undefined ? {} : { enricher: backend.enricher }),
		capabilities: backend.capabilities,
		versionKeys: () => backend.versionKeys(),
	};
}
