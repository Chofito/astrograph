import type { QueryProbe } from "./harness";

/**
 * Named questions a pipeline fixture can pin (AG-301, AG-303 through AG-306).
 *
 * A probe's name is part of its golden, so it says what is being asked rather
 * than which method is called: `callers:handle` reads as a claim, `callers-1`
 * does not. The four completeness domains reachable from the public tools are
 * all represented, because `partial` is computed per domain and a fixture that
 * only ever asked one kind of question could not tell them apart:
 *
 * | Domain | Probes |
 * |---|---|
 * | global discovery | {@link searchProbe}, {@link filesProbe}, {@link statusProbe} |
 * | reverse reachability | {@link callersProbe}, {@link impactProbe} |
 * | forward reachability | {@link calleesProbe}, {@link nodeProbe} |
 * | path existence | {@link traceProbe} |
 */

export function searchProbe(query: string, limit?: number): QueryProbe {
	return {
		name: `search:${query}`,
		run: (graph) =>
			graph.search(limit === undefined ? { query } : { query, limit }),
	};
}

export function callersProbe(symbol: string): QueryProbe {
	return {
		name: `callers:${symbol}`,
		run: (graph) => graph.callers({ symbol }),
	};
}

export function calleesProbe(symbol: string): QueryProbe {
	return {
		name: `callees:${symbol}`,
		run: (graph) => graph.callees({ symbol }),
	};
}

export function impactProbe(symbol: string): QueryProbe {
	return { name: `impact:${symbol}`, run: (graph) => graph.impact({ symbol }) };
}

export function nodeProbe(symbol: string): QueryProbe {
	return { name: `node:${symbol}`, run: (graph) => graph.getNode({ symbol }) };
}

export function traceProbe(from: string, to: string): QueryProbe {
	return {
		name: `trace:${from}->${to}`,
		run: (graph) => graph.trace({ from, to }),
	};
}

export function filesProbe(): QueryProbe {
	return { name: "files", run: (graph) => graph.getFiles({}) };
}

export function statusProbe(): QueryProbe {
	return { name: "status", run: (graph) => graph.getStats({}) };
}
