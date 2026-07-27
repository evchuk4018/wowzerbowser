import type { NextConfig } from "next";

const pdfRuntimeTraceFiles = [
  "./node_modules/pdfjs-dist/**/*",
  "./node_modules/@napi-rs/canvas/**/*",
  "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
  "./node_modules/@napi-rs/canvas-linux-x64-musl/**/*",
  "./node_modules/@napi-rs/canvas-linux-arm64-gnu/**/*",
  "./node_modules/@napi-rs/canvas-linux-arm64-musl/**/*",
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/chat": pdfRuntimeTraceFiles,
    "/api/chat/documents/finalize": pdfRuntimeTraceFiles,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
