import assert from "node:assert/strict";
import test from "node:test";
import { createProjectCollectionHandlers } from "../app/api/projects/route.ts";
import { createProjectHandler } from "../app/api/projects/[projectId]/route.ts";
import { createProjectChatsHandler } from "../app/api/projects/[projectId]/chats/route.ts";
import { createProjectFilesListHandler } from "../app/api/projects/[projectId]/files/route.ts";
import { createProjectFileHandler } from "../app/api/projects/[projectId]/files/[fileId]/route.ts";

const owner = { id: "owner" };
const project = {
  id: "project_1",
  title: "Research",
  instructions: "Use primary sources.",
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
};
const fileId = "11111111-1111-4111-8111-111111111111";
const file = {
  id: fileId,
  projectId: project.id,
  name: "notes.txt",
  contentType: "text/plain",
  size: 5,
  sha256: "a".repeat(64),
  state: "complete",
  createdAt: "2026-08-06T12:00:00.000Z",
};

function streamFor(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("project collection routes authenticate and format service responses", async () => {
  const calls = [];
  const handlers = createProjectCollectionHandlers({
    authorizeOwnerSession: async () => owner,
    listProjects: async (ownerId) => {
      calls.push(["list", ownerId]);
      return [project];
    },
    createProject: async (ownerId, body) => {
      calls.push(["create", ownerId, body]);
      return project;
    },
  });

  const response = await handlers.POST(new Request("http://test/api/projects", {
    method: "POST",
    body: JSON.stringify({ title: "Research", instructions: "Use primary sources." }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).project, project);
  assert.deepEqual(calls[0], ["create", "owner", { title: "Research", instructions: "Use primary sources." }]);

  const list = await handlers.GET(new Request("http://test/api/projects"));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).projects, [project]);

  const unauthorized = await createProjectCollectionHandlers({
    authorizeOwnerSession: async () => null,
    listProjects: async () => { throw new Error("must not list"); },
    createProject: async () => { throw new Error("must not create"); },
  }).GET(new Request("http://test/api/projects"));
  assert.equal(unauthorized.status, 401);
});

test("project item routes validate ids and delegate CRUD", async () => {
  const calls = [];
  const handlers = createProjectHandler({
    authorizeOwnerSession: async () => owner,
    getProject: async (...args) => { calls.push(["get", ...args]); return project; },
    updateProject: async (...args) => { calls.push(["update", ...args]); return { ...project, title: "Updated" }; },
    deleteProject: async (...args) => { calls.push(["delete", ...args]); return true; },
  });

  const updated = await handlers.PATCH(new Request("http://test/api/projects/project_1", {
    method: "PATCH",
    body: JSON.stringify({ title: "Updated" }),
    headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ projectId: "project_1" }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).project.title, "Updated");
  assert.deepEqual(calls[0], ["update", "owner", "project_1", { title: "Updated" }]);

  const deleted = await handlers.DELETE(new Request("http://test/api/projects/project_1", { method: "DELETE" }), { params: { projectId: "project_1" } });
  assert.equal(deleted.status, 204);
  assert.deepEqual(calls.at(-1), ["delete", "owner", "project_1"]);

  const invalid = await handlers.GET(new Request("http://test/api/projects/no!"), { params: { projectId: "no!" } });
  assert.equal(invalid.status, 404);
  assert.equal(calls.filter(([kind]) => kind === "get").length, 0);
});

test("project chat routes list and create metadata through scoped services", async () => {
  const calls = [];
  const handlers = createProjectChatsHandler({
    authorizeOwnerSession: async () => owner,
    listProjectChatsForOwner: async (...args) => { calls.push(["list", ...args]); return [{ id: "chat_1", projectId: project.id, title: "Chat", createdAt: "now", updatedAt: "now", hasMessages: false, isStreaming: false }]; },
    createProjectChat: async (...args) => { calls.push(["create", ...args]); return { id: "chat_2", projectId: project.id, title: "New", createdAt: "now", updatedAt: "now", hasMessages: false, isStreaming: false }; },
  });

  const list = await handlers.GET(new Request("http://test/api/projects/project_1/chats"), { params: { projectId: "project_1" } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).chats[0].id, "chat_1");

  const created = await handlers.POST(new Request("http://test/api/projects/project_1/chats", { method: "POST", body: JSON.stringify({ title: "New" }) }), { params: Promise.resolve({ projectId: "project_1" }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).chat.id, "chat_2");
  assert.deepEqual(calls, [["list", "owner", "project_1"], ["create", "owner", "project_1", { title: "New" }]]);
});

test("project file routes list, stream, and delete owner-scoped metadata", async () => {
  const calls = [];
  const handlers = createProjectFilesListHandler({
    authorizeOwnerSession: async () => owner,
    listProjectFileMetadata: async (...args) => { calls.push(["list", ...args]); return [file]; },
  });
  const list = await handlers(new Request("http://test/api/projects/project_1/files"), { params: { projectId: "project_1" } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).files, [file]);

  const fileHandlers = createProjectFileHandler({
    authorizeOwnerSession: async () => owner,
    readProjectFile: async (...args) => { calls.push(["read", ...args]); return { metadata: file, stream: streamFor(Uint8Array.from([104, 101, 108, 108, 111])), size: 5 }; },
    deleteProjectFile: async (...args) => { calls.push(["delete", ...args]); return true; },
  });
  const read = await fileHandlers.GET(new Request("http://test/api/projects/project_1/files/" + fileId), { params: { projectId: "project_1", fileId } });
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), Uint8Array.from([104, 101, 108, 108, 111]));
  assert.equal(read.headers.get("content-disposition"), "attachment; filename=\"notes.txt\"");

  const deleted = await fileHandlers.DELETE(new Request("http://test/api/projects/project_1/files/" + fileId, { method: "DELETE" }), { params: Promise.resolve({ projectId: "project_1", fileId }) });
  assert.equal(deleted.status, 204);
  assert.deepEqual(calls, [["list", "owner", "project_1"], ["read", "owner", "project_1", fileId], ["delete", "owner", "project_1", fileId]]);
});
