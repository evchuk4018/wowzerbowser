import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace routes keep auth, validation, and service calls at the route boundary", async () => {
  const [list, read, search, file, asset] = await Promise.all([
    readFile(new URL("../app/api/chat/workspace/[conversationId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/workspace/[conversationId]/read/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/workspace/[conversationId]/search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/workspace/[conversationId]/file/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/workspace/[conversationId]/asset/[...path]/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [list, read, search, file, asset]) {
    assert.match(source, /authorizeOwnerSession/);
    assert.match(source, /NextResponse\.json/);
    assert.match(source, /WorkspaceRequestError/);
  }
  assert.match(list, /listWorkspaceFiles/);
  assert.match(read, /readWorkspaceFile/);
  assert.match(search, /searchWorkspaceFiles/);
  assert.match(file, /writeWorkspaceFile/);
  assert.match(file, /deleteWorkspaceFile/);
  assert.match(asset, /readWorkspaceAsset/);
  assert.match(asset, /path\.join\("\/"\)/);
  assert.match(asset, /content-disposition/);
  assert.match(asset, /content-security-policy/);
  assert.match(asset, /sandbox allow-scripts/);
  assert.match(asset, /authorizeOwnerSession/);
});
