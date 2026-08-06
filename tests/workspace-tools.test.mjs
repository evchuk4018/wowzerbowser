import assert from "node:assert/strict";
import test from "node:test";
import { executeWorkspaceTool } from "../app/server/agent/workspace-tool.ts";
import {
  RUN_COMMAND_TOOL_NAME,
  WORKSPACE_PATCH_TOOL_NAME,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_SEARCH_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAME,
} from "../app/server/agent/workspace-tool-manifest.ts";

function mockExecutor() {
  const files = new Map([["index.html", "<h1>Hello</h1>\n"]]);
  return {
    async listWorkspaceTree() {
      return [...files.entries()].map(([path, content]) => ({ path, size: Buffer.byteLength(content) }));
    },
    async readWorkspaceFile(path) {
      if (!files.has(path)) throw new Error("Artifact not found.");
      return new TextEncoder().encode(files.get(path));
    },
    async writeWorkspaceFile(path, bytes) {
      files.set(path, new TextDecoder().decode(bytes));
    },
    async deleteWorkspaceFile(path) {
      files.delete(path);
    },
    async runCommand() {
      files.set("generated.py", "print(1)\n");
      return { command: "python", args: ["-m", "compileall"], cwd: "", stdout: "ok", stderr: "", exitCode: 0, durationMs: 3, changedFiles: [{ path: "generated.py", size: 9 }] };
    },
  };
}

const context = (executor) => ({ ownerId: "owner", conversationId: "00000000-0000-4000-8000-000000000000", executor });
const call = (name, args) => ({ id: `call-${name}`, name, arguments: JSON.stringify(args) });

test("workspace read and search return bounded agent-readable results", async () => {
  const executor = mockExecutor();
  const read = await executeWorkspaceTool(call(WORKSPACE_READ_TOOL_NAME, { path: "index.html", startLine: 1, endLine: 1 }), context(executor));
  assert.equal(read.ok, true);
  assert.match(read.stdout, /1: <h1>Hello<\/h1>/);
  const search = await executeWorkspaceTool(call(WORKSPACE_SEARCH_TOOL_NAME, { query: "hello" }), context(executor));
  assert.equal(search.ok, true);
  assert.match(search.stdout, /index\.html/);
});

test("workspace writes and patches reuse the existing file and publish a current artifact", async () => {
  const executor = mockExecutor();
  const registered = [];
  const dependencies = { registerArtifact: async (input) => { registered.push(input); return { id: "artifact-1", name: input.name, contentType: input.contentType, size: input.bytes.byteLength, workspacePath: input.workspacePath, editable: true }; } };
  const write = await executeWorkspaceTool(call(WORKSPACE_WRITE_TOOL_NAME, { path: "index.html", content: "<h1>Updated</h1>\n" }), context(executor), dependencies);
  assert.equal(write.ok, true);
  assert.equal(registered[0].workspacePath, "index.html");
  const patch = await executeWorkspaceTool(call(WORKSPACE_PATCH_TOOL_NAME, { path: "index.html", oldText: "Updated", newText: "Patched", expectedOccurrences: 1 }), context(executor), dependencies);
  assert.equal(patch.ok, true);
  assert.match(new TextDecoder().decode(await executor.readWorkspaceFile("index.html")), /Patched/);
});

test("bounded commands return changed files as artifacts", async () => {
  const executor = mockExecutor();
  const result = await executeWorkspaceTool(call(RUN_COMMAND_TOOL_NAME, { command: "python", args: ["-V"] }), context(executor), {
    registerArtifact: async (input) => ({ id: "artifact-generated", name: input.name, contentType: input.contentType, size: input.bytes.byteLength, workspacePath: input.workspacePath }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts?.[0]?.workspacePath, "generated.py");
});
