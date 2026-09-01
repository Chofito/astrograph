export type { PhpBackendOptions } from "./php/backend";
export { createPhpBackend, PhpLanguageBackend } from "./php/backend";
export type {
	ReconcileOptions,
	ReconcilePlan,
	ReconcileStats,
} from "./reconcile";
export { reconcileNodes } from "./reconcile";
export type { CreateRegistryOptions } from "./registry";
export {
	BackendRegistrationError,
	createDefaultRegistry,
	EXTRACTION_CONTRACT_VERSION,
	grammarsForRegistry,
	LanguageRegistry,
	shippedBackendExtensionOwners,
} from "./registry";
export { isGenerated, isTest } from "./shared/classify";
export { extensionsForLanguage, languageFromPath } from "./shared/language";
export type { QualifiedNameInput } from "./shared/qualified-name";
export { buildQualifiedName } from "./shared/qualified-name";
export type {
	GrammarUnavailable,
	TreeSitterLang,
} from "./tree-sitter/grammars";
export {
	initTreeSitter,
	isGrammarLoaded,
	isTreeSitterReady,
	loadedGrammars,
	loadGrammars,
	TREE_SITTER_WASMS_VERSION,
	treeSitterLangFromPath,
	treeSitterRuntimeFailure,
	unavailableGrammars,
} from "./tree-sitter/grammars";
export { TreeSitterParser } from "./tree-sitter/parser";
export { TypescriptLanguageBackend } from "./typescript/backend";
export type { TsExtractorOptions } from "./typescript/extractor";
export { TsExtractor } from "./typescript/extractor";
export type { NodeIdentity } from "./typescript/identity";
export { computeNodeIdentity } from "./typescript/identity";
export type { ResolverOptions, ResolverResult } from "./typescript/resolver";
export { resolveEdgesForFile } from "./typescript/resolver";
