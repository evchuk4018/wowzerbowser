import type { NextConfig } from "next";

const canvasTraceFiles = [
  "./node_modules/@napi-rs/canvas/**/*",
  "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
  "./node_modules/@napi-rs/canvas-linux-x64-musl/**/*",
  "./node_modules/@napi-rs/canvas-linux-arm64-gnu/**/*",
  "./node_modules/@napi-rs/canvas-linux-arm64-musl/**/*",
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/chat": canvasTraceFiles,
    "/api/chat/documents/finalize": canvasTraceFiles,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
