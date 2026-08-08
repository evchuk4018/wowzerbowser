import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(new URL("../app/server/projects/project-repository.ts", import.meta.url), "utf8");

test("project assignment persists a client-only conversation before returning project metadata", async () => {
  const repository = await source();

  assert.match(repository, /const conversation = \(await transaction\.unsafe[\s\S]*?\)\[0\];/);
  assert.match(repository, /if \(!conversation\) \{[\s\S]*?insert into chat_conversations\(owner_id,conversation_id,project_id,title\)/);
  assert.match(repository, /values\(\$1,\$2,\$3,coalesce\(\$4,'New conversation'\)\)/);
  assert.match(repository, /false as has_messages,[\s\S]*?false as is_streaming/);
  assert.match(repository, /return projectChatFromRow\(created\);/);
});
