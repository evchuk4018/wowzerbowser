import assert from "node:assert/strict";
import test from "node:test";
import { expectedCanvasPackages } from "../scripts/pdf-runtime-platform.mjs";

test("selects the exact native canvas package for supported runtimes",()=>{
 assert.deepEqual(expectedCanvasPackages({platform:"linux",arch:"x64",libc:"gnu"}),["@napi-rs/canvas-linux-x64-gnu"]);
 assert.deepEqual(expectedCanvasPackages({platform:"linux",arch:"arm64",libc:"musl"}),["@napi-rs/canvas-linux-arm64-musl"]);
 assert.deepEqual(expectedCanvasPackages({platform:"win32",arch:"x64"}),["@napi-rs/canvas-win32-x64-msvc"]);
 assert.deepEqual(expectedCanvasPackages({platform:"darwin",arch:"arm64"}),["@napi-rs/canvas-darwin-arm64"]);
});

test("rejects unsupported native canvas targets",()=>{
 assert.deepEqual(expectedCanvasPackages({platform:"linux",arch:"riscv64",libc:"gnu"}),[]);
 assert.deepEqual(expectedCanvasPackages({platform:"freebsd",arch:"x64"}),[]);
});
