import type { Node as TsNode } from "web-tree-sitter";

/**
 * PHP name resolution helpers.
 *
 * FQNs are stored *without* a leading `\`. A type reference resolves by the
 * language rules only — never by bare-name search across the project.
 */

/** Strip a leading `\`, collapse empties. Empty string = global namespace. */
export function normalizePhpFqn(name: string): string {
	return name.replace(/\\+/g, "\\").replace(/^\\/, "").replace(/\\$/, "");
}

export function phpFqnJoin(
	namespaceName: string | undefined,
	shortName: string,
): string {
	const ns = namespaceName ? normalizePhpFqn(namespaceName) : "";
	const name = normalizePhpFqn(shortName);
	if (ns === "") return name;
	if (name === "") return ns;
	return `${ns}\\${name}`;
}

/**
 * Build the local alias → FQN table from `namespace_use_declaration` nodes
 * in scope for the current namespace block (or the whole file for `;` form).
 */
export function buildAliasTable(container: TsNode): Map<string, string> {
	const aliases = new Map<string, string>();
	for (let i = 0; i < container.namedChildCount; i++) {
		const child = container.namedChild(i);
		if (!child || child.type !== "namespace_use_declaration") continue;
		collectUseDeclaration(child, aliases);
	}
	return aliases;
}

/** Merge one `namespace_use_declaration` into an alias table. */
export function collectUseDeclaration(
	node: TsNode,
	aliases: Map<string, string>,
): void {
	const group = namedChildOfType(node, "namespace_use_group");
	if (group) {
		const prefixNode =
			namedChildOfType(node, "namespace_name") ??
			namedChildOfType(node, "qualified_name");
		const prefix = prefixNode ? normalizePhpFqn(prefixNode.text) : "";
		for (let i = 0; i < group.namedChildCount; i++) {
			const clause = group.namedChild(i);
			if (!clause || clause.type !== "namespace_use_group_clause") continue;
			const nameNode =
				namedChildOfType(clause, "namespace_name") ??
				namedChildOfType(clause, "qualified_name") ??
				namedChildOfType(clause, "name");
			if (!nameNode) continue;
			const tail = normalizePhpFqn(nameNode.text);
			const fqn = phpFqnJoin(prefix, tail);
			const alias = aliasName(clause) ?? lastSegment(tail);
			aliases.set(alias, fqn);
		}
		return;
	}

	const clause = namedChildOfType(node, "namespace_use_clause");
	if (!clause) return;
	const targetNode =
		namedChildOfType(clause, "qualified_name") ??
		namedChildOfType(clause, "namespace_name") ??
		namedChildOfType(clause, "name");
	if (!targetNode) return;
	const fqn = normalizePhpFqn(targetNode.text);
	const alias = aliasName(clause) ?? lastSegment(fqn);
	aliases.set(alias, fqn);
}

function aliasName(clause: TsNode): string | undefined {
	const aliasing = namedChildOfType(clause, "namespace_aliasing_clause");
	const name = aliasing ? namedChildOfType(aliasing, "name") : undefined;
	return name?.text;
}

/**
 * Resolve a type name to an FQN using only the alias table and current
 * namespace — no project-wide fuzzy matching.
 *
 * Returns `undefined` when the reference text is empty / unusable.
 */
export function resolveTypeReference(
	raw: string,
	aliases: Map<string, string>,
	currentNamespace: string | undefined,
): string | undefined {
	const text = raw.trim();
	if (text === "") return undefined;

	if (text.startsWith("\\")) {
		return normalizePhpFqn(text);
	}

	const firstSlash = text.indexOf("\\");
	const head = firstSlash === -1 ? text : text.slice(0, firstSlash);
	const rest = firstSlash === -1 ? "" : text.slice(firstSlash + 1);
	const mapped = aliases.get(head);
	if (mapped !== undefined) {
		return rest === "" ? mapped : phpFqnJoin(mapped, rest);
	}

	return phpFqnJoin(currentNamespace, text);
}

export function lastSegment(fqn: string): string {
	const normalized = normalizePhpFqn(fqn);
	const idx = normalized.lastIndexOf("\\");
	return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function namedChildOfType(
	node: TsNode,
	type: string,
): TsNode | undefined {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type === type) return child;
	}
	return undefined;
}

export function namedChildrenOfTypes(
	node: TsNode,
	types: ReadonlySet<string>,
): TsNode[] {
	const found: TsNode[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child && types.has(child.type)) found.push(child);
	}
	return found;
}

export const TYPE_NAME_NODE_TYPES = new Set([
	"name",
	"qualified_name",
	"namespace_name",
]);

export const PHP_BUILTIN_TYPES = new Set([
	"string",
	"int",
	"float",
	"bool",
	"array",
	"void",
	"mixed",
	"never",
	"self",
	"static",
	"parent",
	"iterable",
	"object",
	"callable",
	"null",
	"false",
	"true",
]);

/** True when a type name is a PHP builtin/relative keyword we never persist. */
export function isPhpBuiltinType(name: string): boolean {
	return PHP_BUILTIN_TYPES.has(normalizePhpFqn(name).toLowerCase());
}
