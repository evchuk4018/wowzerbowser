export function detectLinuxLibc(platform = process.platform) {
  if (platform !== "linux") return null;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
}

export function expectedCanvasPackages({ platform = process.platform, arch = process.arch, libc = detectLinuxLibc(platform) } = {}) {
  if (platform === "linux" && (arch === "x64" || arch === "arm64") && (libc === "gnu" || libc === "musl")) {
    return [`@napi-rs/canvas-linux-${arch}-${libc}`];
  }
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return [`@napi-rs/canvas-win32-${arch}-msvc`];
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return [`@napi-rs/canvas-darwin-${arch}`];
  return [];
}
