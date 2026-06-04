import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  basePath: '/astrograph',
  assetPrefix: '/astrograph/',
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
