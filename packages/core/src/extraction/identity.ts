import ts from "typescript";
import type { Hasher, NodeKind, Range } from "../types";
import { makeNodeId } from "../ids";
import { buildQualifiedName } from "./qualified-name";

export interface NodeIdentity {
	id: string;
	kind: NodeKind;
	name: string;
	qualifiedName: string;
	locator?: string;
	signature: string;
}

export function computeNodeIdentity(
	decl: ts.Node,
	sourceFile: ts.SourceFile,
	project: string,
	hasher: Hasher,
	filePathOverride?: string,
): NodeIdentity {
	const filePath = filePathOverride ?? sourceFile.fileName;
	const kind = kindFromDeclaration(decl, sourceFile);
	const name = nameFromDeclaration(decl, sourceFile);
	const parts = buildNameParts(decl, sourceFile);
	const qualifiedName = buildQualifiedName({ filePath, parts });
	const sigNode = getSignatureNode(decl);
	const sigSourceFile = sigNode.getSourceFile();
	const signature = extractSignature(sigNode, sigSourceFile);
	const locator = computeOverloadLocator(decl, sourceFile, hasher);

	const id = makeNodeId(
		{
			project,
			filePath,
			kind,
			qualifiedName,
			locator,
		},
		hasher,
	);

	return { id, kind, name, qualifiedName, locator, signature };
}

function buildNameParts(node: ts.Node, sourceFile: ts.SourceFile): string[] {
	const parts: string[] = [];

	if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
		return [`import(${nameFromDeclaration(node, sourceFile)})`];
	}

	if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
		return [`export(${nameFromDeclaration(node, sourceFile)})`];
	}

	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		parts.unshift(node.name.text);
		let current: ts.Node | undefined = node.parent?.parent;
		while (current && !ts.isSourceFile(current)) {
			if (isNamedContainer(current)) {
				parts.unshift(nameFromDeclaration(current, current.getSourceFile()));
			}
			current = current.parent;
		}
		return parts;
	}

	parts.unshift(nameFromDeclaration(node, sourceFile));
	let current: ts.Node | undefined = node.parent;
	while (current && !ts.isSourceFile(current)) {
		if (isNamedContainer(current)) {
			parts.unshift(nameFromDeclaration(current, current.getSourceFile()));
		}
		current = current.parent;
	}
	return parts;
}

function isNamedContainer(node: ts.Node): boolean {
	return (
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isModuleDeclaration(node)
	);
}

export function kindFromDeclaration(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): NodeKind {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isEnumDeclaration(node)) return "enum";
	if (ts.isEnumMember(node)) return "enum_member";
	if (ts.isTypeAliasDeclaration(node)) return "type_alias";
	if (ts.isModuleDeclaration(node)) return "namespace";
	if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
		return "method";
	if (ts.isMethodSignature(node)) return "method";
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
		return "property";
	if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) return "property";
	if (ts.isVariableDeclaration(node)) return kindFromVariableDeclaration(node);
	if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
		return "import";
	if (ts.isExportDeclaration(node) || ts.isExportAssignment(node))
		return "export";
	return "variable";
}

function kindFromVariableDeclaration(decl: ts.VariableDeclaration): NodeKind {
	const init = decl.initializer;
	if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
		return "function";
	if (init && ts.isClassExpression(init)) return "class";
	const flags = (decl.parent as ts.VariableDeclarationList).flags;
	if ((flags & ts.NodeFlags.Const) !== 0) return "constant";
	return "variable";
}

export function nameFromDeclaration(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): string {
	if (ts.isFunctionDeclaration(node)) {
		if (node.name) return node.name.text;
		if (hasDefaultModifier(node)) return "default";
		return "<anonymous>";
	}
	if (ts.isClassDeclaration(node)) {
		if (node.name) return node.name.text;
		if (hasDefaultModifier(node)) return "default";
		return "<anonymous>";
	}
	if (ts.isInterfaceDeclaration(node)) return node.name.text;
	if (ts.isEnumDeclaration(node)) return node.name.text;
	if (ts.isEnumMember(node)) return node.name.getText(sourceFile);
	if (ts.isTypeAliasDeclaration(node)) return node.name.text;
	if (ts.isModuleDeclaration(node)) return node.name.getText(sourceFile);
	if (ts.isMethodDeclaration(node))
		return node.name?.getText(sourceFile) ?? "<anonymous>";
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isMethodSignature(node))
		return node.name?.getText(sourceFile) ?? "<anonymous>";
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
		return node.name?.getText(sourceFile) ?? "<anonymous>";
	if (ts.isGetAccessor(node) || ts.isSetAccessor(node))
		return node.name?.getText(sourceFile) ?? "<anonymous>";
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
		return node.name.text;
	if (ts.isImportDeclaration(node)) {
		const moduleName = ts.isStringLiteral(node.moduleSpecifier)
			? node.moduleSpecifier.text
			: node.moduleSpecifier.getText(sourceFile);
		return moduleName;
	}
	if (ts.isImportEqualsDeclaration(node)) {
		return node.moduleReference.getText(sourceFile);
	}
	if (ts.isExportAssignment(node)) return "default";
	if (ts.isExportDeclaration(node)) {
		if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			return `re-export(${node.moduleSpecifier.text})`;
		}
		if (node.exportClause) return node.exportClause.getText(sourceFile);
		return node.getText(sourceFile).slice(0, 40);
	}
	return "<unknown>";
}

function getSignatureNode(node: ts.Node): ts.Node {
	if (ts.isVariableDeclaration(node)) {
		return node.parent.parent;
	}
	return node;
}

function findOverloadSiblings(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): ts.Node[] {
	if (ts.isFunctionDeclaration(node) && node.name) {
		const name = node.name.text;
		const container = node.parent;
		const statements = ts.isSourceFile(container)
			? container.statements
			: ts.isModuleBlock(container)
				? container.statements
				: undefined;
		if (!statements) return [node];
		return statements.filter(
			(s): s is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(s) && s.name?.text === name,
		);
	}

	if (ts.isMethodDeclaration(node)) {
		const name = node.name?.getText(sourceFile);
		const parent = node.parent;
		if (
			(ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) &&
			name
		) {
			return parent.members.filter(
				(m): m is ts.MethodDeclaration =>
					ts.isMethodDeclaration(m) && m.name?.getText(sourceFile) === name,
			);
		}
	}

	if (ts.isMethodSignature(node)) {
		const name = node.name?.getText(sourceFile);
		const parent = node.parent;
		if (ts.isInterfaceDeclaration(parent) && name) {
			return parent.members.filter(
				(m): m is ts.MethodSignature =>
					ts.isMethodSignature(m) && m.name?.getText(sourceFile) === name,
			);
		}
	}

	return [node];
}

function computeOverloadLocator(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	hasher: Hasher,
): string | undefined {
	const siblings = findOverloadSiblings(node, sourceFile);
	if (siblings.length <= 1) return undefined;

	const sorted = [...siblings].sort(
		(a, b) => a.getStart(sourceFile) - b.getStart(sourceFile),
	);

	const hashes = sorted.map((s) => {
		const sigNode = getSignatureNode(s);
		return hasher.hash(extractSignature(sigNode, sigNode.getSourceFile()));
	});

	const hashCounts = new Map<string, number>();
	for (const hash of hashes) {
		hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
	}

	const nodeIndex = sorted.indexOf(node);
	if (nodeIndex === -1) return undefined;

	const nodeHash = hashes[nodeIndex]!;
	const needsOrdinal = (hashCounts.get(nodeHash) ?? 0) > 1;

	if (!needsOrdinal) return `sig:${nodeHash}`;

	let ordinal = 0;
	for (let i = 0; i < nodeIndex; i++) {
		if (hashes[i] === nodeHash) ordinal++;
	}

	return `sig:${nodeHash}:${ordinal}`;
}

export function getRange(node: ts.Node, sourceFile: ts.SourceFile): Range {
	const start = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	);
	const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
	return {
		startLine: start.line + 1,
		endLine: end.line + 1,
		startColumn: start.character,
		endColumn: end.character,
	};
}

export function extractSignature(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): string {
	const start = node.getStart(sourceFile);
	const text = sourceFile.text;

	const body = (node as ts.FunctionDeclaration | ts.MethodDeclaration).body;
	if (body && ts.isBlock(body)) {
		return collapse(text.slice(start, body.getStart(sourceFile)));
	}

	if (
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isModuleDeclaration(node)
	) {
		const fullText = text.slice(start, node.getEnd());
		const braceIdx = fullText.indexOf("{");
		if (braceIdx !== -1) return collapse(fullText.slice(0, braceIdx));
	}

	if (ts.isTypeAliasDeclaration(node)) {
		return collapse(node.getText(sourceFile));
	}

	if (ts.isVariableStatement(node)) {
		return collapse(node.getText(sourceFile));
	}

	if (
		ts.isImportDeclaration(node) ||
		ts.isImportEqualsDeclaration(node) ||
		ts.isExportDeclaration(node) ||
		ts.isExportAssignment(node)
	) {
		return collapse(node.getText(sourceFile));
	}

	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
		return collapse(node.getText(sourceFile));
	}

	if (ts.isEnumMember(node)) {
		return collapse(node.getText(sourceFile));
	}

	return collapse(node.getText(sourceFile));
}

function collapse(s: string): string {
	return s.trim().replace(/\s+/g, " ");
}

export function extractDocstring(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	source: string,
): string | undefined {
	const ranges = ts.getLeadingCommentRanges(source, node.getFullStart());
	if (!ranges || ranges.length === 0) return undefined;

	for (let i = ranges.length - 1; i >= 0; i--) {
		const range = ranges[i]!;
		const commentText = source.slice(range.pos, range.end);
		if (commentText.startsWith("/**")) {
			return cleanJSDoc(commentText);
		}
	}

	return undefined;
}

function cleanJSDoc(text: string): string {
	return text
		.replace(/^\/\*\*\s?/, "")
		.replace(/\s?\*\/$/, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/, ""))
		.join("\n")
		.trim();
}

export function extractDecorators(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): string[] {
	if (!ts.canHaveDecorators(node)) return [];
	const decorators = ts.getDecorators(node);
	if (!decorators) return [];
	return decorators.map((d) => d.expression.getText(sourceFile));
}

export function extractTypeParameters(node: ts.Node): string[] {
	const tp = (
		node as
			| ts.FunctionDeclaration
			| ts.ClassDeclaration
			| ts.InterfaceDeclaration
			| ts.TypeAliasDeclaration
	).typeParameters;
	if (!tp) return [];
	return tp.map((p) => p.name.text);
}

export function hasExportModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return (
		modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
	);
}

export function hasDefaultModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return (
		modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false
	);
}

export function hasAsyncModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function hasStaticModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return (
		modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false
	);
}

export function hasAbstractModifier(node: ts.Node): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return (
		modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false
	);
}

export function getVisibility(
	node: ts.Node,
): "public" | "private" | "protected" | undefined {
	if (!ts.canHaveModifiers(node)) return undefined;
	const modifiers = ts.getModifiers(node);
	if (!modifiers) return undefined;
	for (const m of modifiers) {
		if (m.kind === ts.SyntaxKind.PublicKeyword) return "public";
		if (m.kind === ts.SyntaxKind.PrivateKeyword) return "private";
		if (m.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
	}
	return undefined;
}
