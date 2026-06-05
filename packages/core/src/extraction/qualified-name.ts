import type { Hasher } from "../types";

export interface QualifiedNameInput {
	filePath: string;
	parts: string[];
}

export function buildQualifiedName(input: QualifiedNameInput): string {
	const { filePath, parts } = input;
	if (parts.length === 0) return filePath;
	return `${filePath}::${parts.join(".")}`;
}

export function buildLocator(
	enclosingParts: string[],
	ordinal: number,
): string {
	if (enclosingParts.length === 0) return `ordinal:${ordinal}`;
	return `${enclosingParts.join(".")}:ordinal:${ordinal}`;
}

export function buildSignatureLocator(
	signature: string,
	hasher: Hasher,
): string {
	return `sig:${hasher.hash(signature)}`;
}
