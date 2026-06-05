const GENERATED_EXT_RE = /\.(generated|gen)\.[jt]sx?$/;
const GENERATED_PB_RE = /\.pb\.[jt]s$/;
const GENERATED_DIR_RE = /(^|\/)__generated__\//;
const GENERATED_HEADER_RE = /^\s*\/\/\s*(@generated|Code generated)/;

const TEST_EXT_RE = /\.(test|spec)\.[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|e2e)\//;

export function isGenerated(filePath: string, source?: string): boolean {
	if (GENERATED_EXT_RE.test(filePath)) return true;
	if (GENERATED_PB_RE.test(filePath)) return true;
	if (GENERATED_DIR_RE.test(filePath)) return true;
	if (source !== undefined && GENERATED_HEADER_RE.test(source)) return true;
	return false;
}

export function isTest(filePath: string): boolean {
	if (TEST_EXT_RE.test(filePath)) return true;
	if (TEST_DIR_RE.test(filePath)) return true;
	return false;
}
