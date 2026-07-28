export interface QualifiedNameInput {
	filePath: string;
	parts: string[];
}

/** `path/to/file.ts::Outer.inner` — the shape every node id hashes over. */
export function buildQualifiedName(input: QualifiedNameInput): string {
	const { filePath, parts } = input;
	if (parts.length === 0) return filePath;
	return `${filePath}::${parts.join(".")}`;
}
