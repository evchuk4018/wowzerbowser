import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
