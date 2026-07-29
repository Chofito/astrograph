# PHP call / instantiates resolution (STEP 3)

Date: 2026-07-29  
Status: approved design  
Depends on: STEP 2 (heritage, imports, type_of, returns) + PHP AST cache (single parse)

## Goal

Emit honest `calls` and `instantiates` edges for PHP from the enricher, using receiver types already available from STEP 2’s name rules and a small intra-class type table. Prefer an honest `unresolved` / `external` edge over a wrong `resolved` one — `impact` and `trace` depend on it.

## Non-goals (document in product docs; do not half-implement)

- Magento `di.xml` `preference` mappings (interface → concrete).
- Generated Factories / Proxies / Interceptors that do not exist on disk.
- Return-type chaining (`$this->a()->b()`).
- `ObjectManager::create`, magic `__call`, trait method bodies.
- Method-name-only fallback across the project.

## Architecture

**Approach:** new module `packages/core/src/extraction/php/calls.ts` with:

- `buildIntraClassTypeTable(...)`
- `lookupMethod(...)` (four-bucket result)
- `emitCallAndInstantiateEdges(...)`

`resolvePhpHeritage` (or a thin rename to `resolvePhpEdges` if needed for clarity) keeps orchestrating one walk over the cached tree: existing STEP 1–2 edges first, then append call/`instantiates` edges from `calls.ts`. Reuse `PhpAstCache` trees; do not re-parse.

Shared helpers stay in `names.ts` (FQN / alias / type reference). STEP 2 emission logic in `resolve.ts` stays behaviorally unchanged except where noted below (`use function` / `use const` filtering).

## Surfaces to emit

| CST | Edge kind | Notes |
|-----|-----------|--------|
| `member_call_expression` | `calls` | `$this->dep->method()`, `$obj->method()` |
| `scoped_call_expression` | `calls` | `parent::foo()`, `self::bar()`, `Static::baz()` |
| `object_creation_expression` | `instantiates` | `new Foo()` |

**Source node:** enclosing method or function Pass A id. If the call is somehow outside a callable, fall back to enclosing class, then file — same discipline as other enrichers; fixtures will put calls inside methods.

**No** leaf call nodes. Edges only.

## Intra-class type table

Built per class declaration from the AST + the same `resolveTypeReference` / FQN index rules as STEP 2:

1. **Promoted constructor properties** — `property_promotion_parameter` → `$name` → FQN of its type (skip builtins).
2. **Typed property declarations** — `property_declaration` with a named type → `$name` → FQN.
3. **Constructor assignment** — in `__construct` body, `$this->prop = $param` when `$param` is a typed constructor parameter (including non-promoted) → `$prop` → that parameter’s FQN. Do not invent types from untyped params or non-`$this` LHS.

Implicit receivers (not property map entries, resolved at the call site):

- `$this` / `self` / `static` → enclosing class FQN.
- `parent` → FQN of the **resolved** `extends` target when present. If `extends` is `external`, treat the receiver as a known external type (bucket 2 for the call). If there is no `extends`, bucket 4 (unknown).

## Receiver resolution at a call site

1. Resolve the receiver expression to an FQN (or “unknown”).
2. Look up that FQN in the project FQN index (class **or interface**).
3. Run method lookup (below).

Receiver forms in scope for STEP 3:

- `$this`, `self`, `static`, `parent`
- `$this->prop` / `$this->prop` as object of a member call when `prop` is in the type table
- Bare/aliased/absolute class name on scoped calls (`Foo::method`, `\Vendor\Foo::method`)
- Typed locals are **out of scope** unless they are `$this->…` properties from the table (no full dataflow)

Chained calls whose intermediate return type is unknown → bucket 4 (`unresolved` / low).

## Method lookup (extends walk = option B)

Start at the resolved receiver type node (class or interface).

1. If the type declares a method with that name → **bucket 1**.
2. Else follow **resolved** `extends` edges only (class→class or interface→interface). Do **not** follow `implements` to concretes. Do **not** use di.xml.
3. Cycle protection: track visited node ids. Depth cap: **32**.
4. Trait handling: do not search trait bodies. If any type visited in the chain has a trait `use` (`use TraitName` inside the class/iface body), mark the chain **incomplete**.
5. Mark the chain **incomplete** when any of these hold on the walk:
   - a visited type has an `extends` edge with `resolutionState: external`;
   - a visited type has a trait `use`;
   - a visited **class** has an `implements` clause whose FQN is not in the project index (external interface). We still do **not** look up methods through `implements` or di.xml; the flag only prevents bucket 3 false “missing method” when the contract may live outside the graph.

Interfaces as **receiver types are in scope**. Looking up a method on the interface (and parent interfaces via resolved `extends`) is reading the declared contract → can be **resolved**. Jumping from interface to an implementing class is **out of scope**.

## Four resolution buckets

| Bucket | Condition | Edge |
|--------|-----------|------|
| 1 | Receiver FQN known; method found on class/iface or ancestor via resolved `extends` | `resolutionState: resolved`, `confidence: high`, `target` = method id |
| 2 | Receiver FQN known; method not found; chain **incomplete** (external extends up the chain, trait `use` anywhere visited, or external interface link that prevents a closed in-project chain) | `resolutionState: external`, `target: null`, `targetName` = best-effort `ReceiverFqn::method` (or equivalent), confidence `high` |
| 3 | Receiver FQN known; method not found; chain fully in-project; no traits; no external links | `resolutionState: unresolved`, `confidence: low`, plus an extraction **warning** (visible, not silent) |
| 4 | Receiver type unknown | `resolutionState: unresolved`, `confidence: low`, no name-only fallback |

Bucket 2 is the **dominant Magento case** (e.g. `getData` on types that extend `Magento\Framework\Model\AbstractModel` only as `external`).

## `new` / `instantiates`

Resolve the constructed type with STEP 2 type-reference rules.

- Type in FQN index: edge `instantiates` from enclosing callable → `__construct` if that method exists on the class, else the class node. Prefer `resolved` / high when the target node exists.
- Type known as FQN but not on disk: `external` (same honesty as heritage).
- Unresolvable type text: `unresolved` / low.

Do not invent Factory/Proxy targets.

## Carry-over: `use function` / `use const`

`collectUseDeclaration` in `names.ts` must ignore `use function` and `use const` (and grouped variants) so they do not enter the **class** alias table. PHP’s symbol namespaces are separate; leaving function/const aliases in the class table can mis-resolve STEP 3 call / type targets.

Because `imports` edges are driven from that same class alias table, `use function` / `use const` also stop producing class-oriented `imports` edges. Function/const import edges are out of scope for this step (document; do not invent a parallel imports path yet).

## Versioning and capabilities

- Add `calls` and `instantiates` to PHP enricher `capabilities.edgeKinds`.
- Bump `enricher:php-names` version key (e.g. `"2"` → `"3"`) so indexes rebuild when call edges appear.

## Docs

Update extraction / MCP / tools honesty notes:

- Four buckets and Magento vendor / `AbstractModel` reality.
- Traits → incomplete chain (bucket 2), not “missing method” (bucket 3).
- Explicitly out of scope: di.xml preferences, generated Factories/Proxies/Interceptors.

## Fixtures

Add `packages/core/__fixtures__/php/calls/` with a golden `graph.json` covering:

1. Bucket 1 — promoted-property receiver; typed-property receiver; constructor-assigned receiver; interface-typed receiver; method on in-project ancestor; `parent::` call; static call; `new Foo()`.
2. Bucket 2 — method lives only on a vendor ancestor (`external` extends); must be `external`, not `resolved` or `unresolved`.
3. Bucket 3 — fully in-project chain, method truly missing → `unresolved` / low + warning.
4. Bucket 4 — unresolvable dynamic receiver → `unresolved` / low.

Wire a focused test file mirroring `heritage.test.ts` / `types.test.ts` (golden compare). Maintainer runs tests; implementer verifies with `bun run typecheck` and `bunx biome check` only.

## Error handling

- Malformed / circular `extends`: stop via visited set + depth cap; do not hang the indexer. Prefer incomplete/external or unresolved per buckets — never crash.
- Missing grammar nodes: skip the call site (no edge) rather than guessing.

## Testing strategy

- Golden graph byte-stable for the new fixture.
- Existing `php/heritage` and `php/types` goldens must remain unchanged (except if `use function` filtering changes imports edges in those fixtures — check and update only if necessary, with an explicit note).
- No full-suite autonomous run in the implementation session unless the user asks.
