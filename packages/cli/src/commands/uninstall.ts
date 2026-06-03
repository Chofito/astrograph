import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CliContext, CliRunResult } from '../cli';
import { CliError, ok } from '../cli';
import { style } from '../format/style';
import {
  isAgentGuideInstalled,
  resolveAgentGuideSource,
  uninstallAgentGuide,
  type AgentGuideResult,
} from '../install/agent-guide';
import { confirm } from '../install/prompt';
import type { AgentGuideLink, Location, Target } from '../install/target';
import { ALL_TARGET_IDS, getTarget } from '../install/targets/all';
import { booleanValue, parseCommandArgs, stringValue } from './parse';

interface Plan {
  target: Target;
  path: string;
  doc: unknown;
  newDoc: unknown;
  hasEntry: boolean;
  guide: AgentGuideLink | undefined;
  guideInstalled: boolean;
  skip: boolean;
  skipReason?: string;
}

async function writeBack(filePath: string, content: string): Promise<void> {
  await Bun.write(filePath, content);
}

export async function runUninstall(args: string[], ctx: CliContext): Promise<CliRunResult> {
  return runUninstallCore(args, ctx, homedir());
}

export async function runUninstallCore(args: string[], ctx: CliContext, homeDir: string): Promise<CliRunResult> {
  const parsed = parseCommandArgs(args, {
    target: { type: 'string', short: 't' },
    location: { type: 'string', short: 'l' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  });

  const targetArg = stringValue(parsed.values, 'target');
  const targetIds = targetArg ? targetArg.split(',').map((s) => s.trim()) : ALL_TARGET_IDS;

  const targets: Target[] = [];
  for (const id of targetIds) {
    const t = getTarget(id);
    if (!t) throw new CliError(`Unknown target: ${id}. Valid targets: ${ALL_TARGET_IDS.join(', ')}`);
    targets.push(t);
  }

  const locationArg = stringValue(parsed.values, 'location');
  if (locationArg !== undefined && locationArg !== 'global' && locationArg !== 'local') {
    throw new CliError('--location must be "global" or "local"');
  }
  const location: Location = (locationArg as Location | undefined) ?? 'global';
  const guideSource = resolveAgentGuideSource({ cwd: ctx.cwd });

  // Build plan
  const plans: Plan[] = [];
  for (const t of targets) {
    if (!t.supportsLocation(location)) {
      plans.push({
        target: t,
        path: '',
        doc: null,
        newDoc: null,
        hasEntry: false,
        guide: undefined,
        guideInstalled: false,
        skip: true,
        skipReason: `--location ${location} not supported (global only)`,
      });
      continue;
    }
    const path = t.configPath(location, ctx.cwd, homeDir);
    const guide = t.agentGuide?.(location, ctx.cwd, homeDir);
    const guideInstalled = guide === undefined ? false : isAgentGuideInstalled(guide, guideSource);
    if (!existsSync(path)) {
      plans.push({ target: t, path, doc: null, newDoc: null, hasEntry: false, guide, guideInstalled, skip: false });
      continue;
    }
    const doc = await t.read(path);
    const has = t.hasEntry(doc);
    const newDoc = has ? t.remove(doc) : doc;
    plans.push({ target: t, path, doc, newDoc, hasEntry: has, guide, guideInstalled, skip: false });
  }

  const toWrite = plans.filter((p) => !p.skip && (p.hasEntry || p.guideInstalled));

  // Nothing to remove
  if (toWrite.length === 0) {
    const lines = plans.map((p) => {
      if (p.skip) return style.warn(`${p.target.label}  ${p.skipReason ?? 'skipped'}`);
      return style.dim(`${p.target.label}  ${style.path(p.path)}  not configured`);
    });
    return ok(lines.join('\n'));
  }

  if (booleanValue(parsed.values, 'yes')) {
    const guideResults = new Map<Target, AgentGuideResult>();
    for (const p of toWrite) {
      if (p.hasEntry) {
        await writeBack(p.path, p.target.serialize(p.newDoc));
      }
      if (p.guide !== undefined) {
        guideResults.set(p.target, await uninstallAgentGuide(p.guide));
      }
    }
    const lines = plans.map((p) => {
      if (p.skip) return style.warn(`${p.target.label}  ${p.skipReason ?? 'skipped'}`);
      return uninstallLine(p, guideResults.get(p.target));
    });
    return ok(lines.join('\n'));
  }

  // Interactive
  const planLines: string[] = [`Uninstall plan (${location}):\n`];
  for (const p of plans) {
    if (p.skip) {
      planLines.push(`  ${style.warn(p.target.label)}  ${style.dim(p.skipReason ?? 'skipped')}`);
    } else if (!p.hasEntry) {
      const guideText = p.guideInstalled ? 'remove agent guide' : 'not configured';
      planLines.push(`  ${style.dim(`${p.target.label}  ${style.path(p.path)}  ${guideText}`)}`);
    } else {
      const action = p.guideInstalled ? 'remove astrograph + agent guide' : 'remove astrograph';
      planLines.push(`  ${style.info(p.target.label)}  ${style.path(p.path)}  ${action}`);
    }
  }
  planLines.push(`\n${style.dim(`${toWrite.length} target(s) will be updated.`)}`);
  process.stdout.write(planLines.join('\n') + '\n\n');

  const confirmed = await confirm('Proceed?');
  if (!confirmed) return ok(style.warn('Aborted.'));

  const guideResults = new Map<Target, AgentGuideResult>();
  for (const p of toWrite) {
    if (p.hasEntry) {
      await writeBack(p.path, p.target.serialize(p.newDoc));
    }
    if (p.guide !== undefined) {
      guideResults.set(p.target, await uninstallAgentGuide(p.guide));
    }
  }

  const resultLines = plans
    .filter((p) => !p.skip)
    .map((p) => uninstallLine(p, guideResults.get(p.target)));
  return ok(resultLines.join('\n'));
}

function uninstallLine(plan: Plan, guideResult: AgentGuideResult | undefined): string {
  const guide = formatGuideResult(guideResult);
  if (!plan.hasEntry && guide === undefined) {
    return style.dim(`${plan.target.label}  ${style.path(plan.path)}  not configured`);
  }

  const main = plan.hasEntry
    ? `${plan.target.label}  ${style.path(plan.path)}  removed`
    : `${plan.target.label}  ${style.path(plan.path)}  not configured`;
  return guide === undefined ? style.success(main) : style.success(`${main}  ${guide}`);
}

function formatGuideResult(result: AgentGuideResult | undefined): string | undefined {
  if (result === undefined) return undefined;
  if (result.action === 'removed') return `agent guide removed: ${style.path(result.path)}`;
  if (result.action === 'skipped') return `agent guide skipped: ${result.reason ?? result.path}`;
  return undefined;
}
