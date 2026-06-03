import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CliContext, CliRunResult } from '../cli';
import { CliError, ok } from '../cli';
import { style } from '../format/style';
import { confirm } from '../install/prompt';
import type { Location, Target } from '../install/target';
import { ALL_TARGET_IDS, getTarget } from '../install/targets/all';
import { booleanValue, parseCommandArgs, stringValue } from './parse';

interface Plan {
  target: Target;
  path: string;
  doc: unknown;
  newDoc: unknown;
  hasEntry: boolean;
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

  // Build plan
  const plans: Plan[] = [];
  for (const t of targets) {
    if (!t.supportsLocation(location)) {
      plans.push({ target: t, path: '', doc: null, newDoc: null, hasEntry: false, skip: true, skipReason: `--location ${location} not supported (global only)` });
      continue;
    }
    const path = t.configPath(location, ctx.cwd, homeDir);
    if (!existsSync(path)) {
      plans.push({ target: t, path, doc: null, newDoc: null, hasEntry: false, skip: false });
      continue;
    }
    const doc = await t.read(path);
    const has = t.hasEntry(doc);
    const newDoc = has ? t.remove(doc) : doc;
    plans.push({ target: t, path, doc, newDoc, hasEntry: has, skip: false });
  }

  const toWrite = plans.filter((p) => !p.skip && p.hasEntry);

  // Nothing to remove
  if (toWrite.length === 0) {
    const lines = plans.map((p) => {
      if (p.skip) return style.warn(`${p.target.label}  ${p.skipReason ?? 'skipped'}`);
      return style.dim(`${p.target.label}  ${style.path(p.path)}  not configured`);
    });
    return ok(lines.join('\n'));
  }

  if (booleanValue(parsed.values, 'yes')) {
    for (const p of toWrite) {
      await writeBack(p.path, p.target.serialize(p.newDoc));
    }
    const lines = plans.map((p) => {
      if (p.skip) return style.warn(`${p.target.label}  ${p.skipReason ?? 'skipped'}`);
      if (!p.hasEntry) return style.dim(`${p.target.label}  ${style.path(p.path)}  not configured`);
      return style.success(`${p.target.label}  ${style.path(p.path)}  removed`);
    });
    return ok(lines.join('\n'));
  }

  // Interactive
  const planLines: string[] = [`Uninstall plan (${location}):\n`];
  for (const p of plans) {
    if (p.skip) {
      planLines.push(`  ${style.warn(p.target.label)}  ${style.dim(p.skipReason ?? 'skipped')}`);
    } else if (!p.hasEntry) {
      planLines.push(`  ${style.dim(`${p.target.label}  ${style.path(p.path)}  not configured`)}`);
    } else {
      planLines.push(`  ${style.info(p.target.label)}  ${style.path(p.path)}  remove astrograph`);
    }
  }
  planLines.push(`\n${style.dim(`${toWrite.length} target(s) will be updated.`)}`);
  process.stdout.write(planLines.join('\n') + '\n\n');

  const confirmed = await confirm('Proceed?');
  if (!confirmed) return ok(style.warn('Aborted.'));

  for (const p of toWrite) {
    await writeBack(p.path, p.target.serialize(p.newDoc));
  }

  const resultLines = plans
    .filter((p) => !p.skip)
    .map((p) =>
      !p.hasEntry
        ? style.dim(`${p.target.label}  ${style.path(p.path)}  not configured`)
        : style.success(`${p.target.label}  ${style.path(p.path)}  removed`),
    );
  return ok(resultLines.join('\n'));
}
