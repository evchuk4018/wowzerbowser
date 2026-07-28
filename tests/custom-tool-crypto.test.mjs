import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCustomToolSecret,
  encryptCustomToolSecret,
} from "../app/server/tools/custom-tool-crypto.ts";

test("custom tool secrets use randomized authenticated encryption", () => {
  const prior = process.env.CUSTOM_TOOL_ENCRYPTION_KEY;
  process.env.CUSTOM_TOOL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const left = encryptCustomToolSecret("calendar-secret");
    const right = encryptCustomToolSecret("calendar-secret");
    assert.notEqual(left.nonce, right.nonce);
    assert.notEqual(left.ciphertext, "calendar-secret");
    assert.equal(left.fingerprint, right.fingerprint);
    assert.equal(decryptCustomToolSecret(left), "calendar-secret");
    assert.throws(() => decryptCustomToolSecret({ ...left, ciphertext: `${left.ciphertext.slice(0, -2)}AA` }));
    assert.doesNotMatch(JSON.stringify(left), /calendar-secret/);
  } finally {
    if (prior === undefined) delete process.env.CUSTOM_TOOL_ENCRYPTION_KEY;
    else process.env.CUSTOM_TOOL_ENCRYPTION_KEY = prior;
  }
});

test("custom tool encryption rejects an invalid deployment key", () => {
  const prior = process.env.CUSTOM_TOOL_ENCRYPTION_KEY;
  process.env.CUSTOM_TOOL_ENCRYPTION_KEY = "too-short";
  try {
    assert.throws(() => encryptCustomToolSecret("secret"), /exactly 32 bytes/);
  } finally {
    if (prior === undefined) delete process.env.CUSTOM_TOOL_ENCRYPTION_KEY;
    else process.env.CUSTOM_TOOL_ENCRYPTION_KEY = prior;
  }
});
