import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../docker/python-worker/server.py", import.meta.url), "utf8");

test("the Python worker exposes bounded, session-scoped workspace operations", () => {
  assert.match(workerSource, /\/v1\/workspace\/list/);
  assert.match(workerSource, /\/v1\/workspace\/read/);
  assert.match(workerSource, /\/v1\/workspace\/search/);
  assert.match(workerSource, /\/v1\/workspace\/write/);
  assert.match(workerSource, /\/v1\/workspace\/delete/);
  assert.match(workerSource, /\/v1\/command/);
  assert.match(workerSource, /shell=False/);
  assert.match(workerSource, /O_NOFOLLOW/);
  assert.match(workerSource, /MAX_SEARCH_RESULTS/);
  assert.match(workerSource, /expected_sha256/);
  assert.doesNotMatch(workerSource, /shell=True/);
});

test("the Python worker allows parallel session handles for one shared workspace", () => {
  assert.match(workerSource, /TOKENS_BY_KEY: dict\[str, set\[str\]\] = \{\}/);
  assert.match(workerSource, /TOKENS_BY_KEY\.setdefault\(key, set\(\)\)\.add\(token\)/);
  assert.match(workerSource, /tokens\.discard\(token\)/);
  assert.match(workerSource, /for token in tokens:\s+SESSIONS_BY_TOKEN\.pop\(token, None\)/);
  assert.doesNotMatch(workerSource, /if key in TOKENS_BY_KEY:\s+raise WorkerError\(409, "Python is already running for this conversation\."\)/);
});

test("LocalPythonExecutor keeps root-directory and file-path contracts distinct", async () => {
  process.env.PYTHON_WORKER_URL = "http://python-worker:5003";
  process.env.PYTHON_WORKER_SECRET = "01234567890123456789012345678901";
  const { LocalPythonExecutor } = await import("../app/server/python/local-python-executor.ts");
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input.toString());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === "/v1/sessions/open") return Response.json({ session: "session-token" });
    if (url.pathname === "/v1/workspace/read") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url.pathname === "/v1/command") {
      return Response.json({
        command: body.command,
        args: body.args,
        cwd: body.cwd,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 3,
      });
    }
    if (url.pathname === "/v1/workspace/search") return Response.json({ matches: [], truncated: false });
    if (url.pathname === "/v1/workspace/list") return Response.json({ items: [] });
    return Response.json({ written: true, deleted: true });
  };

  try {
    const executor = new LocalPythonExecutor("owner", "conversation");
    await executor.listWorkspaceTree(".");
    await executor.searchWorkspace("needle", "");
    assert.deepEqual(await executor.readWorkspaceFile("source.txt"), new Uint8Array([1, 2, 3]));
    await assert.rejects(() => executor.readWorkspaceFile("."), /safe relative path/);
    await executor.writeWorkspaceFile("source.txt", new Uint8Array([4]), { overwrite: true, expectedSha256: "a".repeat(64) });
    await executor.replaceWorkspaceFile("source.txt", "b".repeat(64), new Uint8Array([5]));
    await executor.deleteWorkspaceFile("source.txt");
    const command = await executor.runCommand({ command: "python", args: ["-V"], cwd: ".", stdin: "", timeoutMs: 500 });
    assert.deepEqual(command, {
      command: "python",
      args: ["-V"],
      cwd: "",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 3,
    });

    const listRequest = requests.find((request) => request.path === "/v1/workspace/list");
    const searchRequest = requests.find((request) => request.path === "/v1/workspace/search");
    const writeRequest = requests.find((request) => request.path === "/v1/workspace/write");
    assert.equal(listRequest.body.path, "");
    assert.equal(searchRequest.body.root, "");
    assert.equal(writeRequest.body.replace, true);
    assert.equal(writeRequest.body.expectedSha256, "a".repeat(64));
    assert.equal(requests.find((request) => request.path === "/v1/command").body.cwd, "");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
