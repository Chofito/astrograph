# Astrograph

A local code graph for **TypeScript, JavaScript and PHP**, built for coding agents.

Astrograph parses your project with [tree-sitter](https://tree-sitter.github.io/), stores
declarations and references in a SQLite file under `.astrograph/`, and answers structural
questions (who calls this, what breaks if I change it, how does A reach B) through a CLI and
an MCP server. Agents get the relevant code in one call instead of grep-and-read loops.

- **Local only.** No network, no telemetry, no LLM calls. Your code never leaves the machine.
- **Fast and incremental.** A few thousand files index in seconds; afterwards only changed files are re-parsed.
- **Honest.** Every reference is tagged `exact`, `inferred`, `ambiguous`, `external` or `unresolved`, never silently guessed.

## Install

```bash
curl -fsSL https://www.chofito.dev/astrograph/install.sh | sh   # installs to ~/.local/bin
astrograph install                                              # registers the MCP server + skill with your agents
```

From source (requires [Bun](https://bun.sh) ≥ 1.2.17):

```bash
bun install
bun run install:local   # compiles dist/astrograph and copies it to ~/.local/bin
```

## Use

```bash
cd my-project
astrograph init                                   # creates .astrograph/ and indexes
astrograph context "how does checkout work"       # ranked symbols + callers/callees + source
astrograph search Cart
astrograph callers CartService.addItem
astrograph callees CheckoutController
astrograph impact "App\Models\Order::total"       # transitive dependents, before you edit
astrograph trace CheckoutPage PaymentGateway.charge
astrograph node OrderRepository --include-code
astrograph explore cart coupon discount           # source blocks grouped by file
astrograph files src/checkout
astrograph status                                 # counts, resolution quality, parse errors
```

Query commands re-sync changed files first. A symbol can be given as a name (`addItem`), a
qualified name (`CartService.addItem`, `App\Cart::add`), `path:name` (`src/cart.ts:addItem`), or an
id from previous output (`#123`). Run `astrograph <command> --help` for each command's options.

| Command | |
|---|---|
| `init [dir]` | Create `.astrograph/` and build the index |
| `index [dir] [--force]` | Bring the index up to date; `--force` rebuilds it |
| `uninit [dir]` | Delete the index |
| `serve --mcp` | Run the MCP server over stdio (what agent hosts launch) |
| `install` / `uninstall` | Add or remove Astrograph from Claude Code, Cursor, Codex and opencode |

### MCP

`astrograph install` writes the server entry for you. To do it by hand, point your host at:

```json
{ "mcpServers": { "astrograph": { "command": "astrograph", "args": ["serve", "--mcp"] } } }
```

Tools: `astrograph_context`, `astrograph_search`, `astrograph_node`, `astrograph_callers`,
`astrograph_callees`, `astrograph_impact`, `astrograph_trace`, `astrograph_explore`,
`astrograph_files`, `astrograph_status`. They are the same operations as the CLI commands. The
server re-syncs changed files before answering, so there is no daemon or watcher to run.

## Configuration

Optional `.astrograph/config.json`:

```json
{
	"exclude": ["public/vendor/", "*.generated.ts"],
	"maxFileSize": 512000
}
```

Files ignored by git (or by `.gitignore` outside a git repo) are skipped, as are `node_modules/`,
`vendor/`, `dist/`, `build/`, `out/`, `coverage/`, `.next/` and minified bundles. `exclude` takes
gitignore-style patterns. Files larger than `maxFileSize` bytes (default 512 KB) are skipped.

## What it understands

| | TypeScript / JavaScript | PHP |
|---|---|---|
| Symbols | classes, interfaces, functions, methods, fields, top-level constants, types, enums | classes, interfaces, traits, enums, functions, methods, properties, constants |
| References | calls, `new`, `extends`/`implements`, JSX elements | calls, `new`, `extends`/`implements`, trait `use` |
| Resolution | imports, re-export barrels, `tsconfig` `paths`/`baseUrl`, workspace packages, `require` | namespaces and `use` imports (including grouped and `use function`) |
| Receiver types | annotations, `new`, typed fields and parameter properties, declared return types, inherited members | typed params and properties, promoted constructor params, constructor DI assignments, `@var`, `new`, `catch` |

What it does **not** do: full type inference. A call on a value whose type is never written down
(`const repo = makeRepo()` where `makeRepo` has no return type) is matched by method name only
when that name is unique in the project (tagged `inferred`), otherwise reported as `ambiguous`.
`astrograph status` shows how much of the project resolved.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md). In short: `git ls-files` → tree-sitter parse per file →
symbols, references and imports into SQLite → a linking pass resolves references using imports,
namespaces and declared types. Nothing but SQLite stays in memory between files.

## Develop

```bash
bun install
bun run dev -- status      # run the CLI from source
bun run typecheck
bun run check              # biome lint + format check
bun test
```

The web site (landing + docs) lives in `apps/site` and is built separately.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
