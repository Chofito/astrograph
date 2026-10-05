import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import embeddedGuideText from "../../../agents/astrograph/SKILL.md" with { type: "text" };
import type { AgentGuideLink } from "./target";

export type AgentGuideAction = "installed" | "linked" | "updated" | "unchanged" | "removed" | "not-found" | "skipped";

export interface AgentGuideResult {
	path: string;
	action: AgentGuideAction;
	reason?: string;
}

export interface AgentGuideSourceOptions {
	cwd?: string;
}

interface EmbeddedAgentGuideSource {
	kind: "embedded";
}

interface ExternalAgentGuideSource {
	kind: "external";
	root: string;
}

export type AgentGuideSource = EmbeddedAgentGuideSource | ExternalAgentGuideSource;

export function resolveAgentGuideSource(_options: AgentGuideSourceOptions = {}): AgentGuideSource {
	const envSource = process.env.ASTROGRAPH_AGENT_GUIDE;
	if (envSource !== undefined && envSource !== "") {
		return { kind: "external", root: resolve(envSource) };
	}

	return { kind: "embedded" };
}

export function isAgentGuideInstalled(link: AgentGuideLink, sourceRoot = resolveAgentGuideSource()): boolean {
	try {
		if (sourceRoot.kind === "external" && isSymlinkToSource(link, sourceRoot.root)) {
			return true;
		}

		return readInstalledGuide(link) === embeddedGuideText;
	} catch {
		return false;
	}
}

export async function installAgentGuide(
	link: AgentGuideLink,
	sourceRoot = resolveAgentGuideSource(),
): Promise<AgentGuideResult> {
	if (sourceRoot.kind === "external") {
		return installExternalAgentGuide(link, sourceRoot.root);
	}

	return installEmbeddedAgentGuide(link);
}

export async function uninstallAgentGuide(link: AgentGuideLink): Promise<AgentGuideResult> {
	if (!pathExists(link.path)) return { path: link.path, action: "not-found" };

	const stat = lstatSync(link.path);
	if (stat.isSymbolicLink()) {
		await unlink(link.path);
		return { path: link.path, action: "removed" };
	}

	if (readInstalledGuide(link) !== embeddedGuideText) {
		return {
			path: link.path,
			action: "skipped",
			reason: "existing non-symlink file",
		};
	}

	if (link.source === "directory") {
		await rm(link.path, { recursive: true, force: true });
	} else {
		await unlink(link.path);
	}
	return { path: link.path, action: "removed" };
}

async function installExternalAgentGuide(link: AgentGuideLink, sourceRoot: string): Promise<AgentGuideResult> {
	const source = sourcePath(link, sourceRoot);
	if (!existsSync(source)) {
		return {
			path: link.path,
			action: "skipped",
			reason: `missing guide source: ${source}`,
		};
	}

	if (pathExists(link.path)) {
		const stat = lstatSync(link.path);
		if (!stat.isSymbolicLink()) {
			if (readInstalledGuide(link) !== embeddedGuideText) {
				return {
					path: link.path,
					action: "skipped",
					reason: "existing non-symlink file",
				};
			}

			if (link.source === "directory") {
				await rm(link.path, { recursive: true, force: true });
			} else {
				await unlink(link.path);
			}
		} else {
			const currentTarget = resolve(dirname(link.path), readlinkSync(link.path));
			if (currentTarget === source) {
				return { path: link.path, action: "unchanged" };
			}

			await unlink(link.path);
		}
	}

	await mkdir(dirname(link.path), { recursive: true });
	await symlink(relative(dirname(link.path), source), link.path);
	return { path: link.path, action: "linked" };
}

async function installEmbeddedAgentGuide(link: AgentGuideLink): Promise<AgentGuideResult> {
	if (!pathExists(link.path)) {
		await writeEmbeddedGuide(link);
		return { path: link.path, action: "installed" };
	}

	const stat = lstatSync(link.path);
	if (stat.isSymbolicLink()) {
		await unlink(link.path);
		await writeEmbeddedGuide(link);
		return { path: link.path, action: "updated" };
	}

	if (link.source === "directory" && !stat.isDirectory()) {
		return {
			path: link.path,
			action: "skipped",
			reason: "existing non-symlink file",
		};
	}

	if (link.source === "file" && !stat.isFile()) {
		return {
			path: link.path,
			action: "skipped",
			reason: "existing non-symlink file",
		};
	}

	const current = readInstalledGuide(link);
	if (current === embeddedGuideText) return { path: link.path, action: "unchanged" };
	// An older Astrograph guide is ours to upgrade; any other file (a user's own AGENTS.md) is not.
	if (current !== undefined && !isAstrographGuide(current)) {
		return {
			path: link.path,
			action: "skipped",
			reason: "existing file is not an Astrograph guide",
		};
	}

	await writeEmbeddedGuide(link);
	return { path: link.path, action: current === undefined ? "installed" : "updated" };
}

/** A guide this installer wrote: its frontmatter names the astrograph skill. */
export function isAstrographGuide(text: string): boolean {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
	return frontmatter !== undefined && /^name:\s*astrograph\s*$/m.test(frontmatter);
}

async function writeEmbeddedGuide(link: AgentGuideLink): Promise<void> {
	const destination = installedGuidePath(link);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, embeddedGuideText, "utf8");
}

function sourcePath(link: AgentGuideLink, sourceRoot: string): string {
	return link.source === "directory" ? sourceRoot : join(sourceRoot, "SKILL.md");
}

function installedGuidePath(link: AgentGuideLink): string {
	return link.source === "directory" ? join(link.path, "SKILL.md") : link.path;
}

function readInstalledGuide(link: AgentGuideLink): string | undefined {
	try {
		return readFileSync(installedGuidePath(link), "utf8");
	} catch {
		return undefined;
	}
}

function isSymlinkToSource(link: AgentGuideLink, sourceRoot: string): boolean {
	const stat = lstatSync(link.path);
	if (!stat.isSymbolicLink()) return false;
	return resolve(dirname(link.path), readlinkSync(link.path)) === sourcePath(link, sourceRoot);
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
