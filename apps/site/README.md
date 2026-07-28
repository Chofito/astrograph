# site

**Astrograph promotion & documentation website** — Next.js + Fumadocs, built with **Bun**, static export to GitHub Pages.

This is a Next.js application generated with [Create Fumadocs](https://github.com/fuma-nama/fumadocs), using **Bun** as the package manager and runtime.

## Development

Run development server:

```bash
bun run dev
```

Open http://localhost:3000 with your browser to see the result.

## Build for production

```bash
bun run build
```

Generates a fully static export in `out/`, ready for GitHub Pages or any static host.

## Project structure

- `lib/source.ts` — content source adapter (MDX loader)
- `lib/layout.shared.tsx` — shared nav/layout options
- `content/docs/*.mdx` — documentation content (curated from `docs/*.md`)
- `app/(home)` — landing page (custom marketing)
- `app/docs` — documentation layout and pages
- `app/api/search/route.ts` — search endpoint (Orama static)
- `source.config.ts` — Fumadocs MDX configuration
- `next.config.mjs` — Next.js config (`output: 'export'`)

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Fumadocs](https://fumadocs.dev)
- [Bun](https://bun.sh) — JavaScript runtime and package manager
