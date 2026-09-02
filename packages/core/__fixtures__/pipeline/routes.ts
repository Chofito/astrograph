import type { AstrographConfig } from "../../src/config";
import type { WatchEvent } from "../../src/types";
import { registryWithThrowingParser } from "./failure-injection";
import type {
	BackendModes,
	FixtureFiles,
	FixtureMutation,
	PipelineManifest,
	PipelineSnapshot,
	QueryProbe,
} from "./harness";
import {
	type PipelineSession,
	runCleanPipeline,
	withPipeline,
} from "./harness";

/**
 * AG-307: one mutation script, four routes, one oracle.
 *
 * The failure this design exists to prevent is four independently authored
 * expected graphs. If each route carried its own expectation, a shared bug
 * would be recorded four times and called convergence. Here every route
 * consumes the *same* {@link MutationScript} and is compared against the *same*
 * reference — a clean full index of the final state — through the AG-301
 * oracle.
 *
 * | Route | How it reaches the final state |
 * |---|---|
 * | `clean-full` | Fresh database over the final filesystem and configuration. This is the reference. |
 * | `reused-full` | Index the initial state, mutate, `indexAll()` again over the same database. |
 * | `scanner-sync` | Index the initial state, mutate, `sync()` — the scanner decides what changed. |
 * | `event-sync` | Index the initial state, mutate, `syncFiles(events)` — a watcher names the paths. |
 *
 * Each route gets its own temporary root and its own SQLite file, so nothing
 * leaks between them. The events the fourth route receives are *derived from the
 * script*, not hand-written per row: a watcher reports adds, changes and
 * unlinks, and a rename is an unlink plus an add on two paths.
 */

export interface MutationScript {
	/** Stable identifier, used in failure messages and test names. */
	id: string;
	/** What this row is evidence for. */
	description: string;
	/** The project before the change. */
	files: FixtureFiles;
	/** Backend modes before the change. */
	modes: BackendModes;
	/** Configuration before the change. */
	config?: Omit<AstrographConfig, "backends">;
	/** Filesystem changes, applied in order. */
	mutations?: readonly FixtureMutation[];
	/**
	 * Configuration after the change. Present only when the row is *about* a
	 * configuration change: a size limit, an exclude, a backend switch. Omitted
	 * means the configuration is identical before and after, which is what keeps
	 * the event route event-scoped instead of project-wide.
	 */
	finalModes?: BackendModes;
	finalConfig?: Omit<AstrographConfig, "backends">;
	/**
	 * Files whose Pass A crashes during the row's *initial* index, before the
	 * mutation is applied.
	 *
	 * This is how the recovery row becomes a four-route row rather than a
	 * one-off test: each non-clean route first suffers an aborted pass, reopens
	 * with a working backend, and only then applies the mutation and advances.
	 * The reference stays a clean index of the final state, so recovery is held
	 * to exactly the same expectation as every other row — which is the point of
	 * "recovery" meaning anything at all.
	 */
	interruptedOn?: readonly string[];
	/** Envelopes compared alongside the graph. */
	probes?: readonly QueryProbe[];
}

export type RouteName =
	| "clean-full"
	| "reused-full"
	| "scanner-sync"
	| "event-sync";

export const ROUTE_NAMES: readonly RouteName[] = [
	"clean-full",
	"reused-full",
	"scanner-sync",
	"event-sync",
];

/** The filesystem the script ends at. */
export function finalFiles(script: MutationScript): FixtureFiles {
	const files: FixtureFiles = { ...script.files };
	for (const mutation of script.mutations ?? []) {
		if ("delete" in mutation) {
			delete files[mutation.delete];
			continue;
		}
		files[mutation.write] = mutation.content;
	}
	return files;
}

function finalModesOf(script: MutationScript): BackendModes {
	return script.finalModes ?? script.modes;
}

function finalConfigOf(
	script: MutationScript,
): Omit<AstrographConfig, "backends"> | undefined {
	return script.finalConfig ?? script.config;
}

/** Whether the configuration itself changed, which every route must apply. */
function configurationChanges(script: MutationScript): boolean {
	return script.finalModes !== undefined || script.finalConfig !== undefined;
}

/**
 * The watch events a watcher would emit for this script.
 *
 * Derived, never authored: a hand-written batch that happened to name an extra
 * path would hide exactly the bug the event route is here to catch. A
 * configuration-only row derives an empty batch — and that is correct. The
 * indexer treats a configuration identity change as project-wide work, so the
 * batch does not need to mention anything for the route to converge.
 */
export function eventsFor(script: MutationScript): WatchEvent[] {
	const before = script.files;
	const after = finalFiles(script);
	const events: WatchEvent[] = [];

	for (const path of Object.keys(after).sort()) {
		if (!(path in before)) events.push({ type: "add", path });
		else if (before[path] !== after[path]) {
			events.push({ type: "change", path });
		}
	}
	for (const path of Object.keys(before).sort()) {
		if (!(path in after)) events.push({ type: "unlink", path });
	}

	return events;
}

/** The manifest describing the script's *final* state, for the clean route. */
export function finalManifest(script: MutationScript): PipelineManifest {
	const config = finalConfigOf(script);
	return {
		id: `${script.id}/clean-full`,
		description: script.description,
		files: finalFiles(script),
		modes: finalModesOf(script),
		...(config === undefined ? {} : { config }),
		probes: [...(script.probes ?? [])],
	};
}

/** Take one route to the script's final state and snapshot it. */
export async function runRoute(
	script: MutationScript,
	route: RouteName,
): Promise<PipelineSnapshot> {
	const probes = [...(script.probes ?? [])];

	if (route === "clean-full") {
		return runCleanPipeline(finalManifest(script));
	}

	const initial: PipelineManifest = {
		id: `${script.id}/${route}`,
		description: script.description,
		files: script.files,
		modes: script.modes,
		...(script.config === undefined ? {} : { config: script.config }),
	};

	const interrupted = script.interruptedOn ?? [];
	const manifest: PipelineManifest =
		interrupted.length === 0
			? initial
			: {
					...initial,
					injection: {
						createRegistry: registryWithThrowingParser("typescript", [
							...interrupted,
						]),
					},
				};

	return withPipeline(manifest, async (session) => {
		if (interrupted.length === 0) {
			await session.indexAll();
		} else {
			// The crash leaves the database holding one generation's rows and none
			// of the next, with the pass identity deliberately not advanced.
			await expectRejection(session.indexAll());
			await session.reopen({ injection: {} });
			await session.indexAll();
		}
		await applyScript(session, script);
		await advance(session, script, route);
		return session.snapshot(probes);
	});
}

/**
 * Await a promise that must reject.
 *
 * Written out rather than using `expect(...).rejects` because this module is
 * imported by the golden updater, which does not run under `bun test`.
 */
async function expectRejection(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch {
		return;
	}
	throw new Error("expected the interrupted pass to reject, but it resolved");
}

/** Apply the filesystem mutations and, if the row has one, the config change. */
async function applyScript(
	session: PipelineSession,
	script: MutationScript,
): Promise<void> {
	await session.mutate(script.mutations ?? []);
	if (!configurationChanges(script)) return;

	// Reopening is how a user changes configuration: the registry, the scanner's
	// extension list and the config hash are all decided when the project opens.
	const config = finalConfigOf(script);
	await session.reopen({
		modes: finalModesOf(script),
		...(config === undefined ? {} : { config }),
	});
}

async function advance(
	session: PipelineSession,
	script: MutationScript,
	route: RouteName,
): Promise<void> {
	if (route === "reused-full") {
		await session.indexAll();
		return;
	}
	if (route === "scanner-sync") {
		await session.sync();
		return;
	}
	await session.syncFiles(eventsFor(script));
}
