import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	output: "export",
	reactStrictMode: true,
	trailingSlash: true,
	basePath: "/astrograph",
	assetPrefix: "/astrograph/",
	images: {
		unoptimized: true,
	},
	// The site has its own lockfile; do not treat the repository root as the workspace.
	turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
};

export default withMDX(config);
