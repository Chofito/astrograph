import type { Target } from "../target";
import { claudeTarget } from "./claude";
import { codexTarget } from "./codex";
import { cursorTarget } from "./cursor";
import { opencodeTarget } from "./opencode";

export const ALL_TARGETS: Target[] = [
	claudeTarget,
	cursorTarget,
	codexTarget,
	opencodeTarget,
];

export const ALL_TARGET_IDS: string[] = ALL_TARGETS.map((t) => t.id);

export function getTarget(id: string): Target | undefined {
	return ALL_TARGETS.find((t) => t.id === id);
}
