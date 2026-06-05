export async function loadValue(): Promise<number> {
	const mod = await import("./module");
	return mod.value;
}
