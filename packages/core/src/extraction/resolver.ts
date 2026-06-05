import ts from "typescript";
import type {
	Edge,
	ExtractionError,
	Hasher,
	Node,
	Confidence,
	Provenance,
} from "../types";
import { makeNodeId } from "../ids";
import {
	computeNodeIdentity,
	hasExportModifier,
	hasDefaultModifier,
	kindFromDeclaration,
	nameFromDeclaration,
} from "./identity";

export interface ResolverOptions {
	program: ts.Program;
	checker: ts.TypeChecker;
	sourceFile: ts.SourceFile;
	filePath: string;
	project: string;
	hasher: Hasher;
	projectFiles: Set<string>;
	rootPath: string;
	now: () => number;
	nodesByFile: Map<string, Node[]>;
	loadNodesForFile: (filePath: string) => Node[];
}

export interface ResolverResult {
	edges: Edge[];
	externalNodes: Node[];
	errors: ExtractionError[];
}

type ResolvedTarget = {
	target: string | null;
	targetName: string;
	resolutionState: "resolved" | "external" | "unresolved" | "ambiguous";
	confidence: Confidence;
	metadata?: Record<string, unknown>;
};

export function resolveEdgesForFile(opts: ResolverOptions): ResolverResult {
	const {
		program,
		checker,
		sourceFile,
		filePath,
		project,
		hasher,
		projectFiles,
		rootPath,
		now,
		nodesByFile,
		loadNodesForFile,
	} = opts;
	const edges: Edge[] = [];
	const externalNodes: Node[] = [];
	const externalNodeIds = new Set<string>();
	const emittedEdgeKeys = new Set<string>();
	const coveredReferencePositions = new Set<number>();
	const errors: ExtractionError[] = [];

	function toRelative(absPath: string): string {
		const normalized = normalizeFsPath(absPath);
		const root = normalizeFsPath(rootPath);
		if (normalized.startsWith(root + "/"))
			return normalized.slice(root.length + 1);
		return normalized;
	}

	function isProjectFile(absPath: string): boolean {
		return projectFiles.has(toRelative(absPath));
	}

	function ensureExternalNode(sym: ts.Symbol, declFile: ts.SourceFile): string {
		const decl = pickDeclaration(sym.getDeclarations() ?? []);
		if (!decl) return makeExternalFallbackId(sym, declFile);

		const relPath = toRelative(declFile.fileName);
		const identity = computeNodeIdentity(
			decl,
			declFile,
			project,
			hasher,
			relPath,
		);

		if (externalNodeIds.has(identity.id)) return identity.id;
		externalNodeIds.add(identity.id);

		externalNodes.push({
			id: identity.id,
			project,
			kind: identity.kind,
			name: identity.name,
			qualifiedName: identity.qualifiedName,
			filePath: relPath,
			language: "typescript",
			range: { startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 },
			isExported: false,
			isAsync: false,
			isStatic: false,
			isAbstract: false,
			isExternal: true,
			isGenerated: false,
			isTest: false,
			updatedAt: now(),
		});

		return identity.id;
	}

	function makeExternalFallbackId(
		sym: ts.Symbol,
		declFile: ts.SourceFile,
	): string {
		const relPath = toRelative(declFile.fileName);
		const name = sym.getName();
		const id = makeNodeId(
			{
				project,
				filePath: relPath,
				kind: "function",
				qualifiedName: `${relPath}::${name}`,
			},
			hasher,
		);

		if (!externalNodeIds.has(id)) {
			externalNodeIds.add(id);
			externalNodes.push({
				id,
				project,
				kind: "function",
				name,
				qualifiedName: `${relPath}::${name}`,
				filePath: relPath,
				language: "typescript",
				range: { startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 },
				isExported: false,
				isAsync: false,
				isStatic: false,
				isAbstract: false,
				isExternal: true,
				isGenerated: false,
				isTest: false,
				updatedAt: now(),
			});
		}
		return id;
	}

	function resolveSymbol(sym: ts.Symbol, location: ts.Node): ResolvedTarget {
		const name = sym.getName();

		let resolved = sym;
		if (resolved.flags & ts.SymbolFlags.Alias) {
			try {
				resolved = checker.getAliasedSymbol(resolved);
			} catch {
				return {
					target: null,
					targetName: name,
					resolutionState: "unresolved",
					confidence: "low",
				};
			}
		}

		const decls = resolved.getDeclarations();
		if (!decls || decls.length === 0) {
			return {
				target: null,
				targetName: name,
				resolutionState: "unresolved",
				confidence: "low",
			};
		}

		const primary = pickDeclaration(decls);
		if (!primary) {
			return {
				target: null,
				targetName: name,
				resolutionState: "unresolved",
				confidence: "low",
			};
		}

		const declSourceFile = primary.getSourceFile();
		const declFilePath = declSourceFile.fileName;

		if (isProjectFile(declFilePath)) {
			const relPath = toRelative(declFilePath);
			const targetId = findNodeIdInFile(primary, relPath, declSourceFile);

			if (!targetId) {
				return {
					target: null,
					targetName: name,
					resolutionState: "unresolved",
					confidence: "low",
				};
			}

			if (decls.length > 1 && !isOverloadSet(decls)) {
				const candidates = decls
					.map((d) => {
						const sf = d.getSourceFile();
						const rel = toRelative(sf.fileName);
						return findNodeIdInFile(d, rel, sf) ?? "";
					})
					.filter((id) => id !== "");
				return {
					target: targetId,
					targetName: name,
					resolutionState: "ambiguous",
					confidence: "medium",
					metadata: { candidates },
				};
			}

			const hasTsIgnore = hasTsIgnoreDirective(location, sourceFile);
			const hasLooseType = isAnyOrUnknownTyped(location);
			return {
				target: targetId,
				targetName: name,
				resolutionState: "resolved",
				confidence: hasTsIgnore || hasLooseType ? "medium" : "high",
			};
		}

		const target = ensureExternalNode(resolved, declSourceFile);
		return {
			target,
			targetName: name,
			resolutionState: "external",
			confidence: "high",
		};
	}

	function getEnclosingDeclaration(node: ts.Node): ts.Node | undefined {
		let current: ts.Node | undefined = node.parent;
		while (current) {
			if (
				(ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
				ts.isVariableDeclaration(current.parent)
			) {
				return current.parent;
			}
			if (
				ts.isFunctionDeclaration(current) ||
				ts.isMethodDeclaration(current) ||
				ts.isConstructorDeclaration(current) ||
				ts.isClassDeclaration(current) ||
				ts.isInterfaceDeclaration(current) ||
				ts.isEnumDeclaration(current) ||
				ts.isModuleDeclaration(current) ||
				ts.isTypeAliasDeclaration(current) ||
				ts.isPropertyDeclaration(current) ||
				ts.isPropertySignature(current) ||
				ts.isGetAccessor(current) ||
				ts.isSetAccessor(current) ||
				ts.isSourceFile(current)
			) {
				return current;
			}
			if (
				ts.isVariableDeclaration(current) &&
				isProjectSourceVariableDeclaration(current)
			) {
				return current;
			}
			if (
				ts.isVariableStatement(current) &&
				hasProjectSourceVariableDeclaration(current)
			) {
				return current;
			}
			current = current.parent;
		}
		return undefined;
	}

	function getSourceId(node: ts.Node): string | undefined {
		const enclosing = getEnclosingDeclaration(node);
		if (!enclosing) return undefined;
		if (ts.isSourceFile(enclosing)) {
			return makeNodeId(
				{
					project,
					filePath,
					kind: "file",
					qualifiedName: filePath,
				},
				hasher,
			);
		}

		if (ts.isVariableDeclaration(enclosing)) {
			return findNodeIdByPosition(enclosing);
		}

		if (ts.isVariableStatement(enclosing)) {
			const decl = enclosing.declarationList.declarations.find(
				(candidate) =>
					ts.isIdentifier(candidate.name) &&
					isProjectSourceVariableDeclaration(candidate),
			);
			return decl === undefined ? undefined : findNodeIdByPosition(decl);
		}

		return findNodeIdByPosition(enclosing);
	}

	function findNodeIdByPosition(astNode: ts.Node): string | undefined {
		return findNodeIdInFile(astNode, filePath, sourceFile);
	}

	function findNodeIdInFile(
		astNode: ts.Node,
		targetFilePath: string,
		targetSourceFile: ts.SourceFile,
	): string | undefined {
		const nodes = getNodesForFile(targetFilePath);
		if (nodes.length === 0) return undefined;

		const rangeNode = rangeNodeForDeclaration(astNode);
		const startLine =
			targetSourceFile.getLineAndCharacterOfPosition(
				rangeNode.getStart(targetSourceFile),
			).line + 1;
		const startColumn = targetSourceFile.getLineAndCharacterOfPosition(
			rangeNode.getStart(targetSourceFile),
		).character;
		const kind = kindFromDeclaration(astNode, targetSourceFile);
		const name = nameFromDeclaration(astNode, targetSourceFile);

		for (const node of nodes) {
			if (
				isCompatibleKind(kind, node.kind) &&
				node.name === name &&
				node.range.startLine === startLine &&
				node.range.startColumn === startColumn
			) {
				return node.id;
			}
		}

		return undefined;
	}

	function getNodesForFile(targetFilePath: string): Node[] {
		const cached = nodesByFile.get(targetFilePath);
		if (cached !== undefined) return cached;

		const loaded = loadNodesForFile(targetFilePath);
		nodesByFile.set(targetFilePath, loaded);
		return loaded;
	}

	function rangeNodeForDeclaration(astNode: ts.Node): ts.Node {
		if (ts.isVariableDeclaration(astNode)) return astNode.parent.parent;
		return astNode;
	}

	function isProjectSourceVariableDeclaration(
		decl: ts.VariableDeclaration,
	): boolean {
		const init = decl.initializer;
		return (
			init !== undefined &&
			(ts.isArrowFunction(init) ||
				ts.isFunctionExpression(init) ||
				ts.isClassExpression(init))
		);
	}

	function hasProjectSourceVariableDeclaration(
		stmt: ts.VariableStatement,
	): boolean {
		return stmt.declarationList.declarations.some(
			isProjectSourceVariableDeclaration,
		);
	}

	function isCompatibleKind(
		expected: Node["kind"],
		actual: Node["kind"],
	): boolean {
		return (
			actual === expected || (expected === "function" && actual === "component")
		);
	}

	function isAnyOrUnknownTyped(location: ts.Node): boolean {
		const type = checker.getTypeAtLocation(location);
		return (
			(type.flags & ts.TypeFlags.Any) !== 0 ||
			(type.flags & ts.TypeFlags.Unknown) !== 0
		);
	}

	function getSourceIdForNode(astNode: ts.Node): string | undefined {
		return findNodeIdByPosition(sourceLookupNode(astNode));
	}

	function sourceLookupNode(astNode: ts.Node): ts.Node {
		if (
			(ts.isArrowFunction(astNode) ||
				ts.isFunctionExpression(astNode) ||
				ts.isClassExpression(astNode)) &&
			ts.isVariableDeclaration(astNode.parent)
		) {
			return astNode.parent;
		}
		return astNode;
	}

	function resolveSymbolAtLocation(
		location: ts.Node,
	): ResolvedTarget | undefined {
		const sym = checker.getSymbolAtLocation(location);
		if (sym === undefined) return undefined;
		return resolveSymbol(sym, location);
	}

	function symbolLocationForExpression(expr: ts.Expression): ts.Node {
		if (ts.isPropertyAccessExpression(expr)) return expr.name;
		if (
			ts.isElementAccessExpression(expr) &&
			expr.argumentExpression !== undefined
		)
			return expr.argumentExpression;
		return expr;
	}

	function emitResolvedEdge(input: {
		source: string;
		location: ts.Node;
		kind: Edge["kind"];
		fallbackTargetName?: string;
		provenance?: Provenance;
		markCovered?: boolean;
	}): void {
		const resolved = resolveSymbolAtLocation(input.location);
		const pos = sourceFile.getLineAndCharacterOfPosition(
			input.location.getStart(sourceFile),
		);

		if (input.markCovered !== false) markCoveredReference(input.location);

		if (resolved === undefined) {
			emitEdge({
				source: input.source,
				target: null,
				targetName:
					input.fallbackTargetName ?? input.location.getText(sourceFile),
				kind: input.kind,
				resolutionState: "unresolved",
				confidence: "low",
				provenance: input.provenance ?? "heuristic",
				line: pos.line + 1,
				col: pos.character,
			});
			return;
		}

		emitEdge({
			source: input.source,
			target: resolved.target,
			targetName: resolved.targetName,
			kind: input.kind,
			resolutionState: resolved.resolutionState,
			confidence: resolved.confidence,
			provenance: input.provenance ?? "ts-compiler",
			line: pos.line + 1,
			col: pos.character,
			metadata: resolved.metadata,
		});
	}

	function emitEdge(input: {
		source: string;
		target: string | null;
		targetName?: string;
		kind: Edge["kind"];
		resolutionState: Edge["resolutionState"];
		confidence: Confidence;
		provenance: Provenance;
		line?: number;
		col?: number;
		metadata?: Record<string, unknown>;
	}): void {
		const key = `${input.source}\u0000${input.kind}\u0000${input.target ?? ""}\u0000${input.line ?? -1}`;
		if (emittedEdgeKeys.has(key)) return;
		emittedEdgeKeys.add(key);

		edges.push({
			source: input.source,
			target: input.target,
			targetName: input.targetName,
			kind: input.kind,
			resolutionState: input.resolutionState,
			confidence: input.confidence,
			provenance: input.provenance,
			line: input.line,
			col: input.col,
			metadata: input.metadata,
		});
	}

	function markCoveredReference(node: ts.Node): void {
		coveredReferencePositions.add(node.getStart(sourceFile));
	}

	function isCoveredReference(node: ts.Node): boolean {
		return coveredReferencePositions.has(node.getStart(sourceFile));
	}

	function emitContainsEdges(): void {
		const fileId = makeNodeId(
			{
				project,
				filePath,
				kind: "file",
				qualifiedName: filePath,
			},
			hasher,
		);

		function visitForContains(
			node: ts.Node,
			parentId: string | undefined,
		): void {
			const declKinds = [
				ts.SyntaxKind.FunctionDeclaration,
				ts.SyntaxKind.ClassDeclaration,
				ts.SyntaxKind.InterfaceDeclaration,
				ts.SyntaxKind.EnumDeclaration,
				ts.SyntaxKind.TypeAliasDeclaration,
				ts.SyntaxKind.ModuleDeclaration,
			];

			if (declKinds.includes(node.kind)) {
				const nodeId = getSourceIdForNode(node);
				if (parentId && nodeId) {
					const pos = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile),
					);
					emitEdge({
						source: parentId,
						target: nodeId,
						kind: "contains",
						resolutionState: "resolved",
						confidence: "high",
						provenance: "ts-compiler",
						line: pos.line + 1,
						col: pos.character,
					});
				}
				ts.forEachChild(node, (child) => visitForContains(child, nodeId));
				return;
			}

			if (ts.isVariableStatement(node)) {
				for (const decl of node.declarationList.declarations) {
					if (!ts.isIdentifier(decl.name)) continue;
					const nodeId = getSourceIdForNode(decl);
					if (parentId && nodeId) {
						const pos = sourceFile.getLineAndCharacterOfPosition(
							node.getStart(sourceFile),
						);
						emitEdge({
							source: parentId,
							target: nodeId,
							kind: "contains",
							resolutionState: "resolved",
							confidence: "high",
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
						});
					}
				}
				return;
			}

			if (
				ts.isMethodDeclaration(node) ||
				ts.isConstructorDeclaration(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isGetAccessor(node) ||
				ts.isSetAccessor(node) ||
				ts.isMethodSignature(node) ||
				ts.isPropertySignature(node) ||
				ts.isEnumMember(node)
			) {
				const nodeId = getSourceIdForNode(node);
				if (parentId && nodeId) {
					const pos = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile),
					);
					emitEdge({
						source: parentId,
						target: nodeId,
						kind: "contains",
						resolutionState: "resolved",
						confidence: "high",
						provenance: "ts-compiler",
						line: pos.line + 1,
						col: pos.character,
					});
				}
				return;
			}

			ts.forEachChild(node, (child) => visitForContains(child, parentId));
		}

		visitForContains(sourceFile, fileId);
	}

	function emitImportEdges(): void {
		ts.forEachChild(sourceFile, (node) => {
			if (!ts.isImportDeclaration(node)) return;

			const sourceId = getSourceIdForNode(node);
			if (!sourceId) return;

			if (!node.importClause) return;

			const clause = node.importClause;

			if (clause.name) {
				const sym = checker.getSymbolAtLocation(clause.name);
				if (sym) {
					const resolved = resolveSymbol(sym, clause.name);
					const pos = sourceFile.getLineAndCharacterOfPosition(
						clause.name.getStart(sourceFile),
					);
					emitEdge({
						source: sourceId,
						target: resolved.target,
						targetName: resolved.targetName,
						kind: "imports",
						resolutionState: resolved.resolutionState,
						confidence: resolved.confidence,
						provenance: "ts-compiler",
						line: pos.line + 1,
						col: pos.character,
						metadata: resolved.metadata,
					});
				}
			}

			if (clause.namedBindings) {
				if (ts.isNamespaceImport(clause.namedBindings)) {
					const sym = checker.getSymbolAtLocation(clause.namedBindings.name);
					if (sym) {
						const resolved = resolveSymbol(sym, clause.namedBindings.name);
						const pos = sourceFile.getLineAndCharacterOfPosition(
							clause.namedBindings.name.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: resolved.target,
							targetName: resolved.targetName,
							kind: "imports",
							resolutionState: resolved.resolutionState,
							confidence: resolved.confidence,
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
							metadata: resolved.metadata,
						});
					}
				} else if (ts.isNamedImports(clause.namedBindings)) {
					for (const spec of clause.namedBindings.elements) {
						const sym = checker.getSymbolAtLocation(spec.name);
						if (sym) {
							const resolved = resolveSymbol(sym, spec.name);
							const pos = sourceFile.getLineAndCharacterOfPosition(
								spec.name.getStart(sourceFile),
							);
							emitEdge({
								source: sourceId,
								target: resolved.target,
								targetName: resolved.targetName,
								kind: "imports",
								resolutionState: resolved.resolutionState,
								confidence: resolved.confidence,
								provenance: "ts-compiler",
								line: pos.line + 1,
								col: pos.character,
								metadata: resolved.metadata,
							});
						}
					}
				}
			}
		});
	}

	function emitExportEdges(): void {
		ts.forEachChild(sourceFile, (node) => {
			if (ts.isExportAssignment(node)) {
				const sourceId = getSourceIdForNode(node);
				if (!sourceId) return;

				const expr = node.expression;
				if (ts.isIdentifier(expr)) {
					const sym = checker.getSymbolAtLocation(expr);
					if (sym) {
						const resolved = resolveSymbol(sym, expr);
						const pos = sourceFile.getLineAndCharacterOfPosition(
							expr.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: resolved.target,
							targetName: resolved.targetName,
							kind: "exports",
							resolutionState: resolved.resolutionState,
							confidence: resolved.confidence,
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
							metadata: resolved.metadata,
						});
					}
				}
				return;
			}

			if (ts.isExportDeclaration(node)) {
				const sourceId = getSourceIdForNode(node);
				if (!sourceId) return;

				if (node.exportClause && ts.isNamedExports(node.exportClause)) {
					for (const spec of node.exportClause.elements) {
						const sym = checker.getSymbolAtLocation(spec.name);
						if (sym) {
							const resolved = resolveSymbol(sym, spec.name);
							const pos = sourceFile.getLineAndCharacterOfPosition(
								spec.name.getStart(sourceFile),
							);
							emitEdge({
								source: sourceId,
								target: resolved.target,
								targetName: resolved.targetName,
								kind: "exports",
								resolutionState: resolved.resolutionState,
								confidence: resolved.confidence,
								provenance: "ts-compiler",
								line: pos.line + 1,
								col: pos.character,
								metadata: resolved.metadata,
							});
						}
					}
				}
				return;
			}

			if (ts.isVariableStatement(node) && hasExportModifier(node)) {
				for (const decl of node.declarationList.declarations) {
					if (!ts.isIdentifier(decl.name)) continue;
					const sourceId = getSourceIdForNode(decl);
					if (!sourceId) continue;
					const sym = checker.getSymbolAtLocation(decl.name);
					if (sym) {
						const pos = sourceFile.getLineAndCharacterOfPosition(
							decl.name.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: sourceId,
							kind: "exports",
							resolutionState: "resolved",
							confidence: "high",
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
						});
					}
				}
				return;
			}

			if (
				(ts.isFunctionDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isInterfaceDeclaration(node) ||
					ts.isEnumDeclaration(node) ||
					ts.isTypeAliasDeclaration(node)) &&
				(hasExportModifier(node) || hasDefaultModifier(node))
			) {
				const sourceId = getSourceIdForNode(node);
				if (!sourceId) return;
				const pos = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				);
				emitEdge({
					source: sourceId,
					target: sourceId,
					kind: "exports",
					resolutionState: "resolved",
					confidence: "high",
					provenance: "ts-compiler",
					line: pos.line + 1,
					col: pos.character,
				});
			}
		});
	}

	function emitCallAndInstantiationEdges(): void {
		function visit(node: ts.Node): void {
			if (ts.isCallExpression(node)) {
				if (hasAncestor(node, ts.isDecorator)) return;

				const sourceId = getSourceId(node);
				if (sourceId) {
					const expr = node.expression;
					const symbolLocation = symbolLocationForExpression(expr);
					markCoveredCallExpression(expr, symbolLocation);
					const sym = checker.getSymbolAtLocation(symbolLocation);
					if (sym) {
						const resolved = resolveSymbol(sym, symbolLocation);
						const pos = sourceFile.getLineAndCharacterOfPosition(
							expr.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: resolved.target,
							targetName: resolved.targetName,
							kind: "calls",
							resolutionState: resolved.resolutionState,
							confidence: resolved.confidence,
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
							metadata: resolved.metadata,
						});
					} else {
						const text = expr.getText(sourceFile);
						const pos = sourceFile.getLineAndCharacterOfPosition(
							expr.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: null,
							targetName: text,
							kind: "calls",
							resolutionState: "unresolved",
							confidence: "low",
							provenance: "heuristic",
							line: pos.line + 1,
							col: pos.character,
						});
					}
				}
			}

			if (ts.isNewExpression(node)) {
				const sourceId = getSourceId(node);
				if (sourceId) {
					const expr = node.expression;
					const symbolLocation = symbolLocationForExpression(expr);
					markCoveredCallExpression(expr, symbolLocation);
					const sym = checker.getSymbolAtLocation(symbolLocation);
					if (sym) {
						const resolved = resolveSymbol(sym, symbolLocation);
						const pos = sourceFile.getLineAndCharacterOfPosition(
							expr.getStart(sourceFile),
						);
						emitEdge({
							source: sourceId,
							target: resolved.target,
							targetName: resolved.targetName,
							kind: "instantiates",
							resolutionState: resolved.resolutionState,
							confidence: resolved.confidence,
							provenance: "ts-compiler",
							line: pos.line + 1,
							col: pos.character,
							metadata: resolved.metadata,
						});
					}
				}
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function emitHeritageEdges(): void {
		function visit(node: ts.Node): void {
			if (
				(ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
				node.heritageClauses
			) {
				const sourceId = getSourceIdForNode(node);
				if (!sourceId) return;

				for (const clause of node.heritageClauses) {
					const edgeKind =
						clause.token === ts.SyntaxKind.ExtendsKeyword
							? "extends"
							: "implements";

					for (const type of clause.types) {
						const expr = type.expression;
						const sym = checker.getSymbolAtLocation(expr);
						if (sym) {
							const resolved = resolveSymbol(sym, expr);
							const pos = sourceFile.getLineAndCharacterOfPosition(
								expr.getStart(sourceFile),
							);
							emitEdge({
								source: sourceId,
								target: resolved.target,
								targetName: resolved.targetName,
								kind: edgeKind as "extends" | "implements",
								resolutionState: resolved.resolutionState,
								confidence: resolved.confidence,
								provenance: "ts-compiler",
								line: pos.line + 1,
								col: pos.character,
								metadata: resolved.metadata,
							});
						}
					}
				}
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function emitTypeAndReturnEdges(): void {
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && node.type) {
				const sourceId = getSourceIdForNode(node) ?? getSourceId(node);
				if (sourceId) emitTypeEdgesFromTypeNode(sourceId, node.type, "type_of");
			} else if (ts.isParameter(node) && node.type) {
				const sourceId = getSourceId(node);
				if (sourceId) emitTypeEdgesFromTypeNode(sourceId, node.type, "type_of");
			} else if (
				(ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
				node.type
			) {
				const sourceId = getSourceIdForNode(node) ?? getSourceId(node);
				if (sourceId) emitTypeEdgesFromTypeNode(sourceId, node.type, "type_of");
			}

			if (
				(ts.isFunctionDeclaration(node) ||
					ts.isMethodDeclaration(node) ||
					ts.isFunctionExpression(node) ||
					ts.isArrowFunction(node)) &&
				node.type
			) {
				const sourceId = getSourceIdForNode(node) ?? getSourceId(node);
				if (sourceId) emitTypeEdgesFromTypeNode(sourceId, node.type, "returns");
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function emitTypeEdgesFromTypeNode(
		sourceId: string,
		typeNode: ts.TypeNode,
		kind: "type_of" | "returns",
	): void {
		for (const location of collectTypeReferenceLocations(typeNode)) {
			emitResolvedEdge({
				source: sourceId,
				location,
				kind,
				fallbackTargetName: location.getText(sourceFile),
			});
		}
	}

	function collectTypeReferenceLocations(typeNode: ts.TypeNode): ts.Node[] {
		const locations: ts.Node[] = [];
		const seen = new Set<number>();

		const add = (location: ts.Node): void => {
			const pos = location.getStart(sourceFile);
			if (seen.has(pos)) return;
			seen.add(pos);
			locations.push(location);
		};

		const visitType = (node: ts.TypeNode): void => {
			if (isPrimitiveTypeNode(node)) return;

			if (ts.isArrayTypeNode(node)) {
				visitType(node.elementType);
				return;
			}

			if (ts.isTypeReferenceNode(node)) {
				const location = entityNameLocation(node.typeName);
				if (!isBuiltinTypeReference(location.getText(sourceFile)))
					add(location);
				for (const arg of node.typeArguments ?? []) visitType(arg);
				return;
			}

			if (ts.isTypeQueryNode(node)) {
				add(entityNameLocation(node.exprName));
				return;
			}

			ts.forEachChild(node, (child) => {
				if (ts.isTypeNode(child)) visitType(child);
			});
		};

		visitType(typeNode);
		return locations.sort(
			(a, b) => a.getStart(sourceFile) - b.getStart(sourceFile),
		);
	}

	function emitOverrideEdges(): void {
		function visit(node: ts.Node): void {
			if (ts.isClassDeclaration(node)) {
				for (const member of node.members) {
					if (!ts.isMethodDeclaration(member) || member.name === undefined)
						continue;
					const sourceId = getSourceIdForNode(member);
					if (!sourceId) continue;

					const overridden = findOverriddenMethodSymbol(node, member);
					if (overridden === undefined) continue;

					const location = member.name;
					const resolved = resolveSymbol(overridden, location);
					const pos = sourceFile.getLineAndCharacterOfPosition(
						location.getStart(sourceFile),
					);
					emitEdge({
						source: sourceId,
						target: resolved.target,
						targetName: resolved.targetName,
						kind: "overrides",
						resolutionState: resolved.resolutionState,
						confidence: resolved.confidence,
						provenance: "ts-compiler",
						line: pos.line + 1,
						col: pos.character,
						metadata: resolved.metadata,
					});
				}
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function findOverriddenMethodSymbol(
		classDecl: ts.ClassDeclaration,
		method: ts.MethodDeclaration,
	): ts.Symbol | undefined {
		const methodName = method.name?.getText(sourceFile);
		if (methodName === undefined) return undefined;

		const classSymbol = classDecl.name
			? checker.getSymbolAtLocation(classDecl.name)
			: undefined;
		const classType = classSymbol
			? checker.getDeclaredTypeOfSymbol(classSymbol)
			: checker.getTypeAtLocation(classDecl);
		const baseTypes = checker.getBaseTypes(classType as ts.InterfaceType) ?? [];
		return findMethodInBaseTypes(methodName, baseTypes, new Set<ts.Type>());
	}

	function findMethodInBaseTypes(
		methodName: string,
		baseTypes: readonly ts.BaseType[],
		seen: Set<ts.Type>,
	): ts.Symbol | undefined {
		for (const baseType of baseTypes) {
			if (seen.has(baseType)) continue;
			seen.add(baseType);

			const direct = baseType.getProperty(methodName);
			if (direct !== undefined) return direct;

			const nextBaseTypes =
				checker.getBaseTypes(baseType as ts.InterfaceType) ?? [];
			const inherited = findMethodInBaseTypes(methodName, nextBaseTypes, seen);
			if (inherited !== undefined) return inherited;
		}

		return undefined;
	}

	function emitDecoratorEdges(): void {
		function visit(node: ts.Node): void {
			if (ts.canHaveDecorators(node)) {
				const decorators = ts.getDecorators(node);
				if (decorators !== undefined) {
					for (const decorator of decorators) {
						const sourceId = getSourceIdForNode(node) ?? getSourceId(node);
						if (!sourceId) continue;

						const location = decoratorSymbolLocation(decorator);
						emitResolvedEdge({
							source: sourceId,
							location,
							kind: "decorates",
							fallbackTargetName: location.getText(sourceFile),
						});
					}
				}
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function decoratorSymbolLocation(decorator: ts.Decorator): ts.Node {
		const expression = decorator.expression;
		if (ts.isCallExpression(expression))
			return symbolLocationForExpression(expression.expression);
		return symbolLocationForExpression(expression);
	}

	function emitReferenceEdges(): void {
		function visit(node: ts.Node): void {
			if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
				emitReferenceForLocation(jsxTagLocation(node.tagName));
				ts.forEachChild(node.attributes, visit);
				return;
			}

			if (ts.isJsxClosingElement(node)) return;

			if (ts.isIdentifier(node) && !shouldSkipReferenceIdentifier(node)) {
				emitReferenceForLocation(node);
			}

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}

	function markCoveredCallExpression(
		expr: ts.Expression,
		symbolLocation: ts.Node,
	): void {
		markCoveredReference(symbolLocation);
		if (ts.isPropertyAccessExpression(expr))
			markCoveredReference(expr.expression);
		if (ts.isElementAccessExpression(expr))
			markCoveredReference(expr.expression);
	}

	function emitReferenceForLocation(location: ts.Node | undefined): void {
		if (location === undefined || isCoveredReference(location)) return;

		const sourceId = getSourceId(location);
		if (!sourceId) return;

		const resolved = resolveSymbolAtLocation(location);
		if (resolved === undefined) return;
		if (resolved.target === null && resolved.resolutionState === "unresolved")
			return;

		const pos = sourceFile.getLineAndCharacterOfPosition(
			location.getStart(sourceFile),
		);
		emitEdge({
			source: sourceId,
			target: resolved.target,
			targetName: resolved.targetName,
			kind: "references",
			resolutionState: resolved.resolutionState,
			confidence: resolved.confidence,
			provenance: "ts-compiler",
			line: pos.line + 1,
			col: pos.character,
			metadata: resolved.metadata,
		});
	}

	function jsxTagLocation(
		tagName: ts.JsxTagNameExpression,
	): ts.Node | undefined {
		if (ts.isIdentifier(tagName)) return tagName;
		if (ts.isPropertyAccessExpression(tagName)) return tagName.name;
		return undefined;
	}

	function shouldSkipReferenceIdentifier(node: ts.Identifier): boolean {
		if (isCoveredReference(node)) return true;
		if (isDeclarationName(node)) return true;
		if (
			hasAncestor(
				node,
				(parent) =>
					ts.isImportDeclaration(parent) ||
					ts.isImportEqualsDeclaration(parent),
			)
		)
			return true;
		if (
			hasAncestor(
				node,
				(parent) =>
					ts.isExportDeclaration(parent) || ts.isExportAssignment(parent),
			)
		)
			return true;
		if (hasAncestor(node, ts.isHeritageClause)) return true;
		if (hasAncestor(node, ts.isTypeNode)) return true;
		if (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
			return true;
		if (ts.isShorthandPropertyAssignment(node.parent)) return false;
		return false;
	}

	function isDeclarationName(node: ts.Identifier): boolean {
		const parent = node.parent;
		return (
			(ts.isFunctionDeclaration(parent) && parent.name === node) ||
			(ts.isClassDeclaration(parent) && parent.name === node) ||
			(ts.isInterfaceDeclaration(parent) && parent.name === node) ||
			(ts.isEnumDeclaration(parent) && parent.name === node) ||
			(ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
			(ts.isModuleDeclaration(parent) && parent.name === node) ||
			(ts.isVariableDeclaration(parent) && parent.name === node) ||
			(ts.isParameter(parent) && parent.name === node) ||
			(ts.isMethodDeclaration(parent) && parent.name === node) ||
			(ts.isPropertyDeclaration(parent) && parent.name === node) ||
			(ts.isPropertySignature(parent) && parent.name === node) ||
			(ts.isMethodSignature(parent) && parent.name === node) ||
			(ts.isEnumMember(parent) && parent.name === node) ||
			(ts.isImportClause(parent) && parent.name === node) ||
			(ts.isImportSpecifier(parent) && parent.name === node) ||
			(ts.isNamespaceImport(parent) && parent.name === node) ||
			(ts.isExportSpecifier(parent) && parent.name === node)
		);
	}

	function hasAncestor(
		node: ts.Node,
		predicate: (node: ts.Node) => boolean,
	): boolean {
		let current: ts.Node | undefined = node.parent;
		while (current !== undefined) {
			if (predicate(current)) return true;
			current = current.parent;
		}
		return false;
	}

	function entityNameLocation(name: ts.EntityName): ts.Identifier {
		return ts.isQualifiedName(name) ? name.right : name;
	}

	function isPrimitiveTypeNode(typeNode: ts.TypeNode): boolean {
		switch (typeNode.kind) {
			case ts.SyntaxKind.StringKeyword:
			case ts.SyntaxKind.NumberKeyword:
			case ts.SyntaxKind.BooleanKeyword:
			case ts.SyntaxKind.VoidKeyword:
			case ts.SyntaxKind.AnyKeyword:
			case ts.SyntaxKind.UnknownKeyword:
			case ts.SyntaxKind.NeverKeyword:
			case ts.SyntaxKind.NullKeyword:
			case ts.SyntaxKind.UndefinedKeyword:
			case ts.SyntaxKind.SymbolKeyword:
			case ts.SyntaxKind.BigIntKeyword:
			case ts.SyntaxKind.ObjectKeyword:
				return true;
			default:
				return false;
		}
	}

	function isBuiltinTypeReference(name: string): boolean {
		return BUILTIN_TYPE_REFERENCES.has(name);
	}

	try {
		emitContainsEdges();
		emitImportEdges();
		emitExportEdges();
		emitCallAndInstantiationEdges();
		emitHeritageEdges();
		emitTypeAndReturnEdges();
		emitOverrideEdges();
		emitDecoratorEdges();
		emitReferenceEdges();
	} catch (err) {
		errors.push({
			message: err instanceof Error ? err.message : String(err),
			filePath,
			severity: "error",
			code: "RESOLVE_ERROR",
		});
	}

	edges.sort(compareEdges);
	return { edges, externalNodes, errors };
}

function normalizeFsPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return normalized.startsWith("/private/var/")
		? normalized.slice("/private".length)
		: normalized;
}

function pickDeclaration(decls: ts.Declaration[]): ts.Declaration | undefined {
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

function isOverloadSet(decls: ts.Declaration[]): boolean {
	if (decls.length <= 1) return true;
	return decls.every(
		(d) =>
			ts.isFunctionDeclaration(d) ||
			ts.isMethodDeclaration(d) ||
			ts.isMethodSignature(d),
	);
}

function hasTsIgnoreDirective(
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

function compareEdges(a: Edge, b: Edge): number {
	return (
		compareStr(a.source, b.source) ||
		compareStr(a.kind, b.kind) ||
		compareStr(a.target ?? "", b.target ?? "") ||
		(a.line ?? -1) - (b.line ?? -1)
	);
}

function compareStr(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const BUILTIN_TYPE_REFERENCES = new Set([
	"Array",
	"ReadonlyArray",
	"Promise",
	"Record",
	"Partial",
	"Required",
	"Readonly",
	"Pick",
	"Omit",
	"Exclude",
	"Extract",
	"NonNullable",
	"Parameters",
	"ReturnType",
	"InstanceType",
	"ThisType",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
]);
