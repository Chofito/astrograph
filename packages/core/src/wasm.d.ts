// `with { type: "file" }` imports resolve to an on-disk path string at runtime
// and are embedded by `bun build --compile`.
declare module "*.wasm" {
	const path: string;
	export default path;
}
