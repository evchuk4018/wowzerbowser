import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { ChatProject, ChatProjectChat } from "../../../lib/chat-project-protocol";
import { databaseOwnerId, isoTimestamp, query } from "../database/database";

type ProjectRow = {
  project_id: string;
  title: string;
  instructions: string;
  created_at: unknown;
  updated_at: unknown;
  deleting_at: unknown;
};

type ProjectChatRow = {
  conversation_id: string;
  project_id: string;
  title: string;
  created_at: unknown;
  updated_at: unknown;
  has_messages: boolean;
  is_streaming: boolean;
};

export function projectLibraryConversationId(projectId: string): string {
  const digest = createHash("sha256").update(`chat-project-library:${projectId}`).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${digest.slice(18, 20)}-${digest.slice(20)}`;
}

function projectFromRow(row: ProjectRow): ChatProject {
  return {
    id: String(row.project_id),
    title: String(row.title),
    instructions: String(row.instructions),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function projectChatFromRow(row: ProjectChatRow): ChatProjectChat {
  return {
    id: String(row.conversation_id),
    projectId: String(row.project_id),
    title: String(row.title),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    hasMessages: Boolean(row.has_messages),
    isStreaming: Boolean(row.is_streaming),
  };
}

export async function listChatProjects(ownerId: string): Promise<ChatProject[]> {
  const rows = await query<ProjectRow>(
    "select project_id,title,instructions,created_at,updated_at,deleting_at from chat_projects where owner_id=$1 and deleting_at is null order by updated_at desc,project_id",
    [databaseOwnerId(ownerId)],
  );
  return rows.map(projectFromRow);
}

export async function getChatProject(ownerId: string, projectId: string): Promise<ChatProject | null> {
  const [row] = await query<ProjectRow>(
    "select project_id,title,instructions,created_at,updated_at,deleting_at from chat_projects where owner_id=$1 and project_id=$2 and deleting_at is null",
    [databaseOwnerId(ownerId), projectId],
  );
  return row ? projectFromRow(row) : null;
}

export async function insertChatProject(input: {
  ownerId: string;
  projectId: string;
  title: string;
  instructions: string;
}): Promise<ChatProject> {
  const [row] = await query<ProjectRow>(
    `insert into chat_projects(owner_id,project_id,title,instructions)
     values($1,$2,$3,$4)
     returning project_id,title,instructions,created_at,updated_at,deleting_at`,
    [databaseOwnerId(input.ownerId), input.projectId, input.title, input.instructions],
  );
  if (!row) throw new Error("Chat project could not be created.");
  return projectFromRow(row);
}

/** Keep parsed project documents in a hidden owner-scoped library conversation. */
export async function ensureProjectLibraryConversation(input: { ownerId: string; projectId: string }): Promise<string> {
  const conversationId = projectLibraryConversationId(input.projectId);
  const owner = databaseOwnerId(input.ownerId);
  const [project] = await query<{ deleting_at: unknown }>(
    "select deleting_at from chat_projects where owner_id=$1 and project_id=$2",
    [owner, input.projectId],
  );
  if (!project || project.deleting_at !== null) throw new Error("The project is not available.");
  const [existing] = await query<{ project_id: string | null; is_project_library: boolean }>(
    "select project_id,is_project_library from chat_conversations where owner_id=$1 and conversation_id=$2",
    [owner, conversationId],
  );
  if (existing && (!existing.is_project_library || existing.project_id !== input.projectId)) {
    throw new Error("The project library conversation identifier is already in use.");
  }
  if (!existing) {
    const inserted = await query<{ conversation_id: string }>(
      `insert into chat_conversations(owner_id,conversation_id,project_id,is_project_library,title)
       select $1,$2,$3,true,'Project files' from chat_projects
        where owner_id=$1 and project_id=$3 and deleting_at is null
        returning conversation_id`,
      [owner, conversationId, input.projectId],
    );
    if (!inserted[0]) throw new Error("The project is not available.");
  }
  return conversationId;
}

export async function getChatProjectForDeletion(ownerId: string, projectId: string): Promise<ChatProject | null> {
  const [row] = await query<ProjectRow>(
    "select project_id,title,instructions,created_at,updated_at,deleting_at from chat_projects where owner_id=$1 and project_id=$2",
    [databaseOwnerId(ownerId), projectId],
  );
  return row ? projectFromRow(row) : null;
}

export async function claimChatProjectDeletion(ownerId: string, projectId: string): Promise<boolean> {
  const rows = await query<{ project_id: string }>(
    "update chat_projects set deleting_at=coalesce(deleting_at,now()),updated_at=now() where owner_id=$1 and project_id=$2 returning project_id",
    [databaseOwnerId(ownerId), projectId],
  );
  return Boolean(rows[0]);
}

export async function updateChatProject(input: {
  ownerId: string;
  projectId: string;
  title?: string;
  instructions?: string;
}): Promise<ChatProject | null> {
  const values: unknown[] = [];
  const updates: string[] = [];
  const set = (column: "title" | "instructions", value: string) => {
    values.push(value);
    updates.push(`${column}=$${values.length}`);
  };
  if (input.title !== undefined) set("title", input.title);
  if (input.instructions !== undefined) set("instructions", input.instructions);
  values.push(new Date().toISOString());
  updates.push(`updated_at=$${values.length}`);
  values.push(databaseOwnerId(input.ownerId), input.projectId);
  const [row] = await query<ProjectRow>(
    `update chat_projects set ${updates.join(",")} where owner_id=$${values.length - 1} and project_id=$${values.length} and deleting_at is null returning project_id,title,instructions,created_at,updated_at,deleting_at`,
    values,
  );
  return row ? projectFromRow(row) : null;
}

/** Remove project chats before deleting the container. Project-owned files are
 * removed by the service before this record-level cascade runs. */
export async function deleteChatProjectRecord(ownerId: string, projectId: string): Promise<boolean> {
  const owner = databaseOwnerId(ownerId);
  await query("update chat_jobs set status='cancelled',completed_at=now(),updated_at=now() where owner_id=$1 and conversation_id in (select conversation_id from chat_conversations where owner_id=$1 and project_id=$2) and status in ('queued','running','awaiting_approval')", [owner, projectId]);
  await query("delete from chat_jobs where owner_id=$1 and conversation_id in (select conversation_id from chat_conversations where owner_id=$1 and project_id=$2)", [owner, projectId]);
  await query("delete from chat_model_preferences where owner_id=$1 and conversation_id in (select conversation_id from chat_conversations where owner_id=$1 and project_id=$2)", [owner, projectId]);
  await query("delete from chat_conversations where owner_id=$1 and project_id=$2", [owner, projectId]);
  const rows = await query<{ project_id: string }>(
    "delete from chat_projects where owner_id=$1 and project_id=$2 returning project_id",
    [owner, projectId],
  );
  return Boolean(rows[0]);
}

export async function listProjectChats(ownerId: string, projectId: string): Promise<ChatProjectChat[]> {
  const rows = await query<ProjectChatRow>(
    `select c.conversation_id,c.project_id,c.title,c.created_at,c.updated_at,
       exists(select 1 from chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id) as has_messages,
       exists(select 1 from chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id and m.role='assistant' and m.status='streaming') as is_streaming
     from chat_conversations c
     where c.owner_id=$1 and c.project_id=$2 and not c.is_project_library
     order by c.updated_at desc,c.conversation_id`,
    [databaseOwnerId(ownerId), projectId],
  );
  return rows.map(projectChatFromRow);
}

export async function insertProjectChat(input: {
  ownerId: string;
  projectId: string;
  conversationId?: string;
  title: string;
}): Promise<ChatProjectChat | null> {
  const conversationId = input.conversationId ?? randomUUID();
  const [row] = await query<ProjectChatRow>(
    `insert into chat_conversations(owner_id,conversation_id,project_id,title)
     select $1,$2,$3,$4
       from chat_projects p
       where p.owner_id=$1 and p.project_id=$3 and p.deleting_at is null
     on conflict (owner_id,conversation_id) do nothing
     returning conversation_id,project_id,title,created_at,updated_at,
       false as has_messages,false as is_streaming`,
    [databaseOwnerId(input.ownerId), conversationId, input.projectId, input.title],
  );
  return row ? projectChatFromRow(row) : null;
}

/** Associate a durable chat submission with an existing owner project. */
export async function ensureProjectChatConversation(input: {
  ownerId: string;
  projectId: string;
  conversationId: string;
}): Promise<void> {
  const owner = databaseOwnerId(input.ownerId);
  const [existing] = await query<{ project_id: string | null }>(
    "select project_id from chat_conversations where owner_id=$1 and conversation_id=$2",
    [owner, input.conversationId],
  );
  if (existing && existing.project_id !== input.projectId) {
    throw new Error("The conversation belongs to a different project.");
  }
  if (existing) {
    await query(
      "update chat_conversations set project_id=$1,updated_at=now() where owner_id=$2 and conversation_id=$3",
      [input.projectId, owner, input.conversationId],
    );
    return;
  }
  const [inserted] = await query<{ project_id: string }>(
    `insert into chat_conversations(owner_id,conversation_id,project_id,title)
     select $1,$2,$3,'New conversation' from chat_projects
      where owner_id=$1 and project_id=$3
     returning project_id`,
    [owner, input.conversationId, input.projectId],
  );
  if (!inserted) throw new Error("Project not found.");
}

export async function getConversationProjectId(ownerId: string, conversationId: string): Promise<string | null> {
  const [row] = await query<{ project_id: string | null }>(
    "select project_id from chat_conversations where owner_id=$1 and conversation_id=$2",
    [databaseOwnerId(ownerId), conversationId],
  );
  return row?.project_id ?? null;
}
