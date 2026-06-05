import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CliContext, CliRunResult } from "../cli";
import { CliError, ok } from "../cli";
import { style, symbols } from "../format/style";
import {
	installAgentGuide,
	isAgentGuideInstalled,
	resolveAgentGuideSource,
	type AgentGuideResult,
} from "../install/agent-guide";
import { confirm } from "../install/prompt";
import { resolveCommand } from "../install/resolve-command";
import type {
	AgentGuideLink,
	Location,
	McpEntry,
	Target,
} from "../install/target";
import { ALL_TARGET_IDS, ALL_TARGETS, getTarget } from "../install/targets/all";
import { booleanValue, parseCommandArgs, stringValue } from "./parse";

interface Plan {
	target: Target;
	path: string;
	doc: unknown;
	newDoc: unknown;
	alreadyInstalled: boolean;
	guide: AgentGuideLink | undefined;
	guideInstalled: boolean;
	skip: boolean;
	skipReason?: string;
}

async function writeConfig(
	filePath: string,
	content: string,
	backup: boolean,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	if (backup && existsSync(filePath)) {
		await Bun.write(`${filePath}.bak`, Bun.file(filePath));
	}
	await Bun.write(filePath, content);
}

function shouldBackup(target: Target, location: Location): boolean {
	return target.id === "claude" && location === "global";
}

export async function runInstall(
	args: string[],
	ctx: CliContext,
): Promise<CliRunResult> {
	return runInstallCore(args, ctx, homedir());
}

export async function runInstallCore(
	args: string[],
	ctx: CliContext,
	homeDir: string,
): Promise<CliRunResult> {
	const parsed = parseCommandArgs(args, {
		target: { type: "string", short: "t" },
		location: { type: "string", short: "l" },
		command: { type: "string" },
		yes: { type: "boolean", short: "y" },
		"print-config": { type: "string" },
		help: { type: "boolean", short: "h" },
	});

	const targetArg = stringValue(parsed.values, "target");
	const targetIds = targetArg
		? targetArg.split(",").map((s) => s.trim())
		: ALL_TARGET_IDS;

	const targets: Target[] = [];
	for (const id of targetIds) {
		const t = getTarget(id);
		if (!t)
			throw new CliError(
				`Unknown target: ${id}. Valid targets: ${ALL_TARGET_IDS.join(", ")}`,
			);
		targets.push(t);
	}

	const locationArg = stringValue(parsed.values, "location");
	if (
		locationArg !== undefined &&
		locationArg !== "global" &&
		locationArg !== "local"
	) {
		throw new CliError('--location must be "global" or "local"');
	}
	const location: Location = (locationArg as Location | undefined) ?? "global";

	const resolved = resolveCommand(stringValue(parsed.values, "command"));
	const mcpEntry: McpEntry = { command: resolved.command, args: resolved.args };
	const guideSource = resolveAgentGuideSource({ cwd: ctx.cwd });

	// --print-config <target>: dry-run, prints the full merged file, writes nothing
	const printConfigId = stringValue(parsed.values, "print-config");
	if (printConfigId !== undefined) {
		const t = getTarget(printConfigId);
		if (!t)
			throw new CliError(
				`Unknown target for --print-config: ${printConfigId}. Valid: ${ALL_TARGET_IDS.join(", ")}`,
			);
		const filePath = t.configPath(location, ctx.cwd, homeDir);
		const doc = await t.read(filePath);
		const newDoc = t.hasEntry(doc) ? doc : t.upsert(doc, mcpEntry);
		const serialized = t.serialize(newDoc);
		const header = `${style.bold(t.label)} (${location})  ${style.path(filePath)}`;
		return ok(`${header}\n\n${serialized}`);
	}

	// Build plan
	const plans: Plan[] = [];
	for (const t of targets) {
		if (!t.supportsLocation(location)) {
			plans.push({
				target: t,
				path: "",
				doc: null,
				newDoc: null,
				alreadyInstalled: false,
				guide: undefined,
				guideInstalled: false,
				skip: true,
				skipReason: `--location ${location} not supported (global only)`,
			});
			continue;
		}
		const path = t.configPath(location, ctx.cwd, homeDir);
		const doc = await t.read(path);
		const alreadyInstalled = t.hasEntry(doc);
		const newDoc = alreadyInstalled ? doc : t.upsert(doc, mcpEntry);
		const guide = t.agentGuide?.(location, ctx.cwd, homeDir);
		plans.push({
			target: t,
			path,
			doc,
			newDoc,
			alreadyInstalled,
			guide,
			guideInstalled:
				guide === undefined ? true : isAgentGuideInstalled(guide, guideSource),
			skip: false,
		});
	}

	const toWrite = plans.filter(
		(p) => !p.skip && (!p.alreadyInstalled || !p.guideInstalled),
	);

	// All already configured
	if (toWrite.length === 0) {
		const lines = plans.map((p) => {
			if (p.skip)
				return style.warn(`${p.target.label}  ${p.skipReason ?? "skipped"}`);
			return style.info(
				`${p.target.label}  ${style.path(p.path)}  already configured`,
			);
		});
		return ok(lines.join("\n"));
	}

	if (booleanValue(parsed.values, "yes")) {
		const guideResults = new Map<Target, AgentGuideResult>();
		for (const p of toWrite) {
			if (!p.alreadyInstalled) {
				await writeConfig(
					p.path,
					p.target.serialize(p.newDoc),
					shouldBackup(p.target, location),
				);
			}
			if (p.guide !== undefined) {
				guideResults.set(
					p.target,
					await installAgentGuide(p.guide, guideSource),
				);
			}
		}
		const lines = plans.map((p) => {
			if (p.skip)
				return style.warn(`${p.target.label}  ${p.skipReason ?? "skipped"}`);
			return installLine(p, guideResults.get(p.target));
		});
		return ok(lines.join("\n"));
	}

	// Interactive: print plan, ask confirm, execute, return result via ok()
	const planLines: string[] = [`Install plan (${location}):\n`];
	for (const p of plans) {
		if (p.skip) {
			planLines.push(
				`  ${style.warn(p.target.label)}  ${style.dim(p.skipReason ?? "skipped")}`,
			);
		} else if (p.alreadyInstalled) {
			const guideText = p.guideInstalled
				? "already configured"
				: "install agent guide";
			planLines.push(
				`  ${style.success(p.target.label)}  ${style.path(p.path)}  ${style.dim(guideText)}`,
			);
		} else {
			const action = p.guideInstalled
				? "add astrograph"
				: "add astrograph + agent guide";
			planLines.push(
				`  ${style.info(p.target.label)}  ${style.path(p.path)}  ${symbols.arrow} ${action}`,
			);
		}
	}
	planLines.push(
		`\n${style.dim(`${toWrite.length} target(s) will be configured.`)}`,
	);
	process.stdout.write(planLines.join("\n") + "\n\n");

	const confirmed = await confirm("Proceed?");
	if (!confirmed) return ok(style.warn("Aborted."));

	const guideResults = new Map<Target, AgentGuideResult>();
	for (const p of toWrite) {
		if (!p.alreadyInstalled) {
			await writeConfig(
				p.path,
				p.target.serialize(p.newDoc),
				shouldBackup(p.target, location),
			);
		}
		if (p.guide !== undefined) {
			guideResults.set(p.target, await installAgentGuide(p.guide, guideSource));
		}
	}

	const resultLines = plans
		.filter((p) => !p.skip)
		.map((p) => installLine(p, guideResults.get(p.target)));
	return ok(resultLines.join("\n"));
}

function installLine(
	plan: Plan,
	guideResult: AgentGuideResult | undefined,
): string {
	const main = plan.alreadyInstalled
		? `${plan.target.label}  ${style.path(plan.path)}  already configured`
		: `${plan.target.label}  ${style.path(plan.path)}`;

	const guide = formatGuideResult(guideResult, plan.guideInstalled);
	if (plan.alreadyInstalled && guide === undefined) return style.info(main);
	if (guide === undefined) return style.success(main);
	return style.success(`${main}  ${symbols.bullet} ${guide}`);
}

function formatGuideResult(
	result: AgentGuideResult | undefined,
	wasInstalled: boolean,
): string | undefined {
	if (result === undefined)
		return wasInstalled ? "agent guide already installed" : undefined;
	if (result.action === "installed")
		return `agent guide installed: ${style.path(result.path)}`;
	if (result.action === "updated")
		return `agent guide updated: ${style.path(result.path)}`;
	if (result.action === "linked")
		return `agent guide linked: ${style.path(result.path)}`;
	if (result.action === "unchanged") return "agent guide already installed";
	if (result.action === "skipped")
		return `agent guide skipped: ${result.reason ?? result.path}`;
	return undefined;
}
