function merged() {
	return 1;
}

namespace merged {
	export const tag = "ns";
}

export function readTag(): string {
	return merged.tag;
}
