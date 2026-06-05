import { describe, expect, test } from "bun:test";
import type { IndexProgress } from "../types";

describe("indexAll onProgress hook", () => {
	test("IndexProgress type has correct shape", () => {
		const progress: IndexProgress = {
			phase: "scan",
			current: 10,
			total: 100,
		};
		expect(progress.phase).toBe("scan");
		expect(progress.current).toBe(10);
		expect(progress.total).toBe(100);
		expect(progress.file).toBeUndefined();
	});

	test("IndexProgress supports all phases", () => {
		const phases: IndexProgress["phase"][] = [
			"scan",
			"parse",
			"resolve",
			"done",
		];
		for (const phase of phases) {
			const progress: IndexProgress = { phase, current: 0, total: 0 };
			expect(progress.phase).toBe(phase);
		}
	});

	test("IndexProgress supports optional file field", () => {
		const progress: IndexProgress = {
			phase: "parse",
			current: 5,
			total: 10,
			file: "src/foo.ts",
		};
		expect(progress.file).toBe("src/foo.ts");
	});

	test("onProgress callback receives monotonic progress", async () => {
		const events: IndexProgress[] = [];
		const onProgress = (e: IndexProgress) => events.push(e);

		const mockIndexAll = async (opts?: {
			onProgress?: (e: IndexProgress) => void;
		}) => {
			opts?.onProgress?.({ phase: "scan", current: 10, total: 10 });
			for (let i = 1; i <= 10; i++) {
				opts?.onProgress?.({
					phase: "parse",
					current: i,
					total: 10,
					file: `file${i}.ts`,
				});
			}
			for (let i = 1; i <= 10; i++) {
				opts?.onProgress?.({
					phase: "resolve",
					current: i,
					total: 10,
					file: `file${i}.ts`,
				});
			}
			opts?.onProgress?.({ phase: "done", current: 10, total: 10 });
		};

		await mockIndexAll({ onProgress });

		expect(events.length).toBeGreaterThan(0);
		expect(events[0]!.phase).toBe("scan");
		expect(events[events.length - 1]!.phase).toBe("done");

		const parseEvents = events.filter((e) => e.phase === "parse");
		for (let i = 1; i < parseEvents.length; i++) {
			expect(parseEvents[i]!.current).toBeGreaterThan(
				parseEvents[i - 1]!.current,
			);
			expect(parseEvents[i]!.current).toBeLessThanOrEqual(
				parseEvents[i]!.total,
			);
		}
	});
});
