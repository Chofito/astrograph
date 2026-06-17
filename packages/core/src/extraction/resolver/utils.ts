import ts from "typescript";
import type { Edge } from "../../types";

export function pickDeclaration(
	decls: ts.Declaration[],
): ts.Declaration | undefined {
	if (decls.length === 0) return undefined;
	if (decls.length === 1) return decls[0];

	const impl = decls.find((d) => {
		if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) {
			return d.body !== undefined;
		}
		return false;
	});
	return impl ?? decls[0];
}

export function isOverloadSet(decls: ts.Declaration[]): boolean {
	if (decls.length <= 1) return true;
	return decls.every(
		(d) =>
			ts.isFunctionDeclaration(d) ||
			ts.isMethodDeclaration(d) ||
			ts.isMethodSignature(d),
	);
}

export function hasTsIgnoreDirective(
	node: ts.Node,
	sourceFile: ts.SourceFile,
): boolean {
	const ranges = ts.getLeadingCommentRanges(
		sourceFile.text,
		node.getFullStart(),
	);
	if (!ranges) return false;
	for (const range of ranges) {
		const text = sourceFile.text.slice(range.pos, range.end);
		if (text.includes("@ts-ignore") || text.includes("@ts-expect-error"))
			return true;
	}
	return false;
}

export function compareEdges(a: Edge, b: Edge): number {
	return (
		compareStr(a.source, b.source) ||
		compareStr(a.kind, b.kind) ||
		compareStr(a.target ?? "", b.target ?? "") ||
		(a.line ?? -1) - (b.line ?? -1)
	);
}

export function compareStr(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
