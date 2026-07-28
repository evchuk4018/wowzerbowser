import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCustomToolMutation,
  validateJsonAgainstSchema,
} from "../lib/custom-tool-protocol.ts";

const valid = {
  name: "google_calendar",
  description: "Create an event.",
  instructions: "Call this when the user asks to create an event.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, duration: { type: "integer" } },
    required: ["title"],
    additionalProperties: false,
  },
  pythonSource: "print('{}')",
  secrets: { GOOGLE_API_KEY: "secret" },
};

test("custom tool mutations normalize a safe provider definition", () => {
  const parsed = parseCustomToolMutation(valid);
  assert.equal(parsed.enabled, false);
  assert.deepEqual(parsed.secrets, { GOOGLE_API_KEY: "secret" });
});

test("custom tool mutations reject unsafe names and schema keywords", () => {
  assert.throws(() => parseCustomToolMutation({ ...valid, name: "bad name" }), /provider-compatible/);
  assert.throws(() => parseCustomToolMutation({
    ...valid, inputSchema: { type: "object", oneOf: [] },
  }), /Unsupported schema keyword/);
  assert.throws(() => parseCustomToolMutation({
    ...valid, secrets: { lower_case: "secret" },
  }), /Secret name or value/);
});

test("custom tool arguments are checked recursively", () => {
  validateJsonAgainstSchema({ title: "Planning", duration: 30 }, valid.inputSchema);
  assert.throws(() => validateJsonAgainstSchema({ duration: 30 }, valid.inputSchema), /title is required/);
  assert.throws(() => validateJsonAgainstSchema({ title: "Planning", extra: true }, valid.inputSchema), /extra is not allowed/);
  assert.throws(() => validateJsonAgainstSchema({ title: "Planning", duration: 1.5 }, valid.inputSchema), /must be integer/);
});
