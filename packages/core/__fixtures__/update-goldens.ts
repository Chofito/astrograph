import { extractFixture, normalizeFixtureGraph } from "./harness";

const fixtures = process.argv.slice(2);
const ALL = [
	"basic",
	"functions",
	"jsx",
	"decorators",
	"exports",
	"overloads",
	"imports/barrel",
	"imports/commonjs",
	"imports/type-only",
	"imports/dynamic-literal",
	"resolution/ambiguous",
] as const;

const targets = fixtures.length > 0 ? fixtures : ALL;

for (const fixture of targets) {
	const normalized = normalizeFixtureGraph(await extractFixture(fixture));
	const goldenPath = `${import.meta.dir}/${fixture}/__golden__/graph.json`;
	const goldenDir = goldenPath.slice(0, goldenPath.lastIndexOf("/"));
	await Bun.$`mkdir -p ${goldenDir}`.quiet();
	await Bun.write(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`);
	console.log(`wrote ${goldenPath}`);
}
