import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  output: 'export', // This enables static export
  trailingSlash: true, // This ensures pages become /page/index.html
};

export default nextConfig;