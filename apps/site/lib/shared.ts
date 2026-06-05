export const appName = "Astrograph";

// Must match `basePath` in next.config.mjs. GitHub Pages project page → '/astrograph'.
// Client-side fetches (e.g. the static search index) are NOT auto-prefixed by Next,
// so we prepend this manually where needed.
export const basePath = "/astrograph";

export const docsRoute = "/docs";
export const docsImageRoute = "/astrograph/og/docs";
export const docsContentRoute = "/astrograph/llms.mdx/docs";

export const gitConfig = {
	user: "Chofito",
	repo: "astrograph",
	branch: "main",
};
