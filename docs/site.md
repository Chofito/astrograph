# Promotion & documentation site design (Stage 3)

> 🌐 Languages: **English** (this file) · _ES mirror pending (see backlog)_

> Design doc for Astrograph's public **website** — a marketing **landing page** plus
> **documentation**, built with **Fumadocs** (Next.js) and deployed as a **fully static
> export to GitHub Pages**. This is NOT the in-app 3D graph explorer (parked; see
> [docs/web.md](web.md)). It is decoupled from the `astrograph` binary. See ROADMAP §6.
>
> ⚠️ Fumadocs evolves fast. Its docs are **LLM-friendly** (append `.mdx` to any page
> URL, or read `https://fumadocs.dev/llms.txt`). Always verify code against the live
> docs (links in §8) before implementing — do not rely on memory.

## 1. Decisions (settled)

| Topic | Decision |
|---|---|
| Framework | **Fumadocs** on **Next.js** (App Router). Scaffold with `bunx create-fumadocs-app`. |
| Two surfaces | **Landing** (`/`, custom marketing page) + **Docs** (`/docs/*`, Fumadocs). One app, one deploy. |
| Hosting | **GitHub Pages**, fully **static export** (`output: 'export'`). No server runtime. |
| Search | **Orama static** (index built at compile time, search runs in the browser — no server). |
| Package manager / runtime | **Bun** (`bun install`, `bun run …`). Next.js runs fine under Bun. (Deviation from the monorepo's "Bun.serve, no Next" rule is **scoped to this standalone site**, justified in ROADMAP §6.) |
| Content source | Reuse the existing **`docs/*.md`** as the docs content (imported/curated into `content/docs/*.mdx`). The repo `docs/` stays the source of truth; the site presents a polished subset. |
| Location in repo | **`apps/site/`** (own Bun workspace member). Distinct from `apps/web/` (the parked explorer) to avoid collision. |
| Styling | Tailwind (Fumadocs ships with it) + custom components for the landing (animations via `motion`/Framer or CSS). |

> **One open decision — site URL** (drives `basePath`):
> - **Project page** `https://<user>.github.io/astrograph/` → set `basePath: '/astrograph'` + `assetPrefix`. ← **assumed default** until told otherwise.
> - **Custom domain / user page** (e.g. `astrograph.dev`) → no `basePath`, cleaner. Add a `CNAME` file.

## 2. Architecture (routes & layouts)

```
apps/site/
├── app/
│   ├── (home)/                 # route group — marketing
│   │   ├── layout.tsx          # <HomeLayout {...baseOptions()}>
│   │   └── page.tsx            # the flashy landing
│   ├── docs/
│   │   ├── layout.tsx          # <DocsLayout> (sidebar, TOC) from page tree
│   │   └── [[...slug]]/page.tsx # renders MDX pages
│   ├── api/search/route.ts     # Orama staticGET (static search index)
│   ├── layout.config.tsx       # shared baseOptions() (nav, links, logo)
│   └── layout.tsx              # root layout (RootProvider)
├── content/docs/               # the docs content (MDX) — curated from repo docs/*.md
│   ├── index.mdx
│   ├── meta.json               # sidebar order / page tree
│   └── …
├── lib/source.ts               # loader(source) — the content source adapter
├── source.config.ts            # fumadocs-mdx config
├── next.config.mjs             # output: 'export' (+ basePath if subpath)
├── public/.nojekyll            # so GitHub Pages serves _next/
└── package.json                # @astrograph/site
```

- **`baseOptions()`** in `layout.config.tsx` holds shared nav (logo, GitHub link, "Docs" link) used by both layouts.
- **Landing** (`app/(home)/page.tsx`) is fully custom — Fumadocs imposes nothing on its content.
- **Docs** are generated from the **page tree** built off `content/docs` + `meta.json`.

## 3. Landing page (the "flashy" part)

A custom marketing page; suggested sections:
1. **Hero** — one-liner ("Local-first code graph for JS/TS that supercharges AI agents"), animated tagline, primary CTA → Docs / install, secondary → GitHub.
2. **The differentiator** — "TS Compiler API depth, not heuristics" (mirror ROADMAP §10): exact resolution, honest coverage, fewer agent tokens/tool-calls.
3. **Surfaces** — CLI · MCP server · agent skills (with a short snippet each).
4. **How it works** — index → query (search/context/impact/trace) → fresh via watcher.
5. **Install** — `astrograph init` + one-command MCP install per host (Claude Code, Cursor, Codex, opencode).
6. **Footer** — links, license (Apache-2.0), author.

Visual treatment is free rein (gradients, a subtle "constellation"/starfield motif nods to the parked explorer without needing 3D). Keep it lightweight — static export, no heavy runtime.

## 4. Docs content

- Curate the repo's `docs/*.md` into `content/docs/*.mdx`. Candidate initial pages:
  `index` (what is Astrograph), `install`, `cli` (from `docs/cli.md`), `mcp` (from
  `docs/mcp.md`), `tools` (from `docs/tools.md`), `graph-model`, `contracts`,
  `testing`, `roadmap` (link or excerpt).
- `meta.json` controls sidebar grouping/order (e.g. *Getting Started* → *Guides* → *Reference*).
- Keep the **repo `docs/` as source of truth**; the site curates and polishes. Decide per-page whether to copy or transclude — a small sync step is fine for V1.

## 5. Search (static, no server)

Orama in **static** mode — index generated at build, search computed client-side:
- **Server route** `app/api/search/route.ts`: export `staticGET` from
  `createFromSource(source)` (`fumadocs-core/search/server`), `export const revalidate = false`.
- **Client**: `useDocsSearch({ type: 'static', initOrama, … })` (`fumadocs-core/search/client` + `@orama/orama`).
- ⚠️ Verify exact code against Fumadocs **Orama static export** + **headless/search/orama#static-export** (§8) — APIs shift between versions.

## 6. Build & deploy (GitHub Pages)

- **`next.config.mjs`**: `output: 'export'`; `images: { unoptimized: true }`;
  `trailingSlash: true`; and **if project subpath**: `basePath: '/astrograph'`,
  `assetPrefix: '/astrograph/'`.
- **`public/.nojekyll`** — mandatory, else Pages skips `_next/` → 404s.
- **GitHub Actions** workflow (`.github/workflows/site.yml`): on push to `main`
  touching `apps/site/**`, `bun install` → `bun run build` (in `apps/site`) →
  upload `out/` as a Pages artifact → `actions/deploy-pages`. Enable Pages = "GitHub Actions".
- **Custom domain (if chosen)**: drop `basePath`/`assetPrefix`, add `public/CNAME`.

## 7. Build order (prompts)

1. **SITE-1 — scaffold + static + landing skeleton + deploy.** `bunx create-fumadocs-app`
   in `apps/site`; wire `output: 'export'` + `.nojekyll` (+ basePath per the URL
   decision); a first custom landing (hero + CTAs); one real docs page (`index.mdx`);
   Orama static search; the GitHub Actions Pages workflow. **Gate: the deployed Pages
   URL loads landing + `/docs` + working search.**
2. **SITE-2 — full docs migration.** Curate `docs/*.md` → `content/docs/*.mdx`, build
   `meta.json` sidebar, cross-links, code blocks, install snippets per host.
3. **SITE-3 — landing polish.** Animations, constellation motif, responsive pass,
   OG/meta images, Lighthouse/perf.

## 8. References (verify before coding — LLM-friendly `.mdx`)

- Quick start: `https://fumadocs.dev/docs.mdx` · all pages: `https://fumadocs.dev/llms.txt`
- Static build: `https://fumadocs.dev/docs/deploying/static.mdx`
- Orama search (static): `https://fumadocs.dev/docs/search/orama.mdx` · headless: `https://fumadocs.dev/docs/headless/search/orama.mdx`
- Home layout (landing): `https://fumadocs.dev/docs/ui/layouts/home-layout.mdx`
- Page conventions (`meta.json` / page tree): `https://fumadocs.dev/docs/page-conventions.mdx`
- MDX content / collections: `https://fumadocs.dev/docs/mdx.mdx`
- Next.js static export: `https://nextjs.org/docs/app/guides/static-exports`
- Astrograph content sources: this repo's `docs/*.md`; differentiator → ROADMAP §10.
