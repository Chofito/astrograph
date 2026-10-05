# Roadmap

**Vision:** a coding agent understands a TypeScript, JavaScript or PHP repository with fewer tool
calls and tokens than with grep and file reads, and gets the answer right.

**Metric:** per task, tool calls, tokens and correctness with vs without Astrograph (the A/B eval).
A feature earns a place here by moving that metric, or by being real pain felt while using the
tool. Everything else waits in *Later* or goes to *Not doing*.

**Budget:** indexing time and peak memory on the reference repositories must not regress more
than 20% (`bun run bench`).

Updated at the end of each release. Concrete work items are GitHub issues; this page is direction only.

## Now — 0.2.0

At most three items.

1. **Ship the rewrite.** Tests green, a week of dogfooding through MCP, merge `rewrite` into
   `main`, tag `v0.2.0`, publish binaries.
2. **A/B eval.** 10–15 real tasks on 2–3 repositories (TS app, TS monorepo, PHP); run an agent with
   and without the MCP server; record tool calls, tokens and correctness. Its first result
   decides the order of *Next*.
3. **Decide the web.** Either `apps/site` stays the only web surface, or the 3D explorer comes
   back as `astrograph web` on the new core. Record the outcome in DECISIONS.md.

## Next

Ordered; the eval may reorder it.

- `astrograph affected <files…>`: changed files → impacted symbols and tests, for CI test selection.
- Cross-call deduplication of source already sent in a session, if the eval shows repeated code
  is a large share of tokens (see DECISIONS.md).
- Search recall in `search` / `context`: typo tolerance, `kind:` / `path:` filters, better
  stemming than the current suffix stripping.
- Resolution gaps seen in real use: object-literal methods (`export const api = { get() {} }`),
  `module.exports = {…}`, calls through generic type parameters.
- Run `bun run bench` in CI against pinned public repositories.

## Later

- More languages (Python, Go): grammar + extractor + resolution rules.
- Lower peak memory (~450 MB on ~4k files), only if it hurts someone.
- Installer: keep comments in `~/.codex/config.toml` (today smol-toml drops them).

## Not doing

See DECISIONS.md for the reasoning behind each.

- A background daemon, file watcher or lock files. Sync-on-query is enough.
- Running a compiler for type inference. Types come only from what the source declares.
- Index migrations. The index is a cache; schema changes rebuild it.
- Storing source code in the index.
- Stage plans, review logs, handoff documents, or translated doc mirrors in the repository.
