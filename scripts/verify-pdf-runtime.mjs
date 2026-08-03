import { createCanvas } from "@napi-rs/canvas";

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
