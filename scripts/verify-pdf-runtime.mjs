import { createCanvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expectedCanvasPackages } from "./pdf-runtime-platform.mjs";

try {
  const canvas = createCanvas(1, 1);
  const png = canvas.toBuffer("image/png");
  canvas.width = 0;
  canvas.height = 0;
  if (!png.length) throw new Error("canvas produced an empty PNG");
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown native canvas error";
  console.error(`PDF runtime validation failed: ${message}`);
  process.exitCode = 1;
}

if (process.argv.includes("--trace")) {
  const platformPackages = expectedCanvasPackages();
  const tracePaths = [
    join(".next", "server", "app", "api", "chat", "route.js.nft.json"),
    join(".next", "server", "app", "api", "chat", "documents", "finalize", "route.js.nft.json"),
  ];
  try {
    for (const tracePath of tracePaths) {
      const trace = JSON.parse(await readFile(tracePath, "utf8"));
      const files = Array.isArray(trace.files) ? trace.files : [];
      for (const marker of ["node_modules/pdfjs-dist/", "node_modules/pdfjs-dist/standard_fonts/", "node_modules/pdfjs-dist/wasm/"]) {
        if (!files.some((file) => file.includes(marker))) {
          throw new Error(`${tracePath} does not include ${marker}`);
        }
      }
      if (!files.some((file) => file.includes("node_modules/@napi-rs/canvas/"))) {
        throw new Error(`${tracePath} does not include @napi-rs/canvas`);
      }
      if (!platformPackages.length) {
        throw new Error(`unsupported native canvas platform: ${process.platform}/${process.arch}`);
      }
      if (!platformPackages.every((name) => files.some((file) => file.includes(`node_modules/${name}/`)))) {
        throw new Error(`${tracePath} does not include the required native canvas package: ${platformPackages.join(", ")}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown function trace error";
    console.error(`PDF function trace validation failed: ${message}`);
    process.exitCode = 1;
  }
}
