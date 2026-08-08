import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { ChatProject, ChatProjectChat } from "../../../lib/chat-project-protocol";
import { databaseOwnerId, isoTimestamp, query, type DatabaseExecutor, withTransaction } from "../database/database";

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

async function ensureProjectLibraryConversationInTransaction(
  transaction: DatabaseExecutor,
  ownerId: string,
  projectId: string,
): Promise<void> {
  const conversationId = projectLibraryConversationId(projectId);
  const [existing] = await transaction.unsafe<{ project_id: string | null; is_project_library: boolean }>(
    "select project_id,is_project_library from chat_conversations where owner_id=$1 and conversation_id=$2 for update",
    [ownerId, conversationId],
  );
  if (existing) {
    if (!existing.is_project_library || existing.project_id !== projectId) {
      throw new Error("The project library conversation identifier is already in use.");
    }
    return;
  }
  const [inserted] = await transaction.unsafe<{ conversation_id: string }>(
    `insert into chat_conversations(owner_id,conversation_id,project_id,is_project_library,title)
     select $1,$2,$3,true,'Project files' from chat_projects
      where owner_id=$1 and project_id=$3 and deleting_at is null
      returning conversation_id`,
    [ownerId, conversationId, projectId],
  );
  if (!inserted) throw new Error("The project is not available.");
}

/**
 * Move the project-owned records associated with one chat while the chat row
 * is locked. Chat-project documents are stored in a hidden library
 * conversation, so those rows are copied to the target library before the
 * old mirror rows are removed. Storage binaries retain their opaque object
 * keys; only their owner/project metadata changes.
 */
async function moveProjectChatResources(input: {
  transaction: DatabaseExecutor;
  ownerId: string;
  conversationId: string;
  sourceProjectId: string | null;
  targetProjectId: string;
}): Promise<void> {
  const { transaction, ownerId, conversationId, sourceProjectId, targetProjectId } = input;
  const targetLibraryConversationId = projectLibraryConversationId(targetProjectId);

  // Keep the complete set stable while subsequent updates change ownership
  // metadata. project_id is the separate source-backed document namespace;
  // only chat-project documents participate in this move.
  await transaction.unsafe(
    `create temporary table project_chat_move_documents on commit drop as
       select documents.*
         from chat_documents documents
        where documents.owner_id=$1
          and documents.project_id is null
          and documents.chat_project_id is not distinct from $3
          and (
            documents.conversation_id=$2
            or exists (
              select 1 from app_storage_objects objects
               where objects.owner_id=documents.owner_id
                 and objects.object_id=documents.storage_object_id
                 and objects.conversation_id=$2
                 and objects.chat_project_id is not distinct from $3
            )
            or exists (
              select 1 from app_storage_objects objects
               where objects.owner_id=documents.owner_id
                 and objects.conversation_id=$2
                 and objects.document_id=documents.document_id
                 and objects.chat_project_id is not distinct from $3
            )
          )`,
    [ownerId, conversationId, sourceProjectId],
  );

  await ensureProjectLibraryConversationInTransaction(transaction, ownerId, targetProjectId);

  if (sourceProjectId) {
    const sourceLibraryConversationId = projectLibraryConversationId(sourceProjectId);

    // chat_documents.storage_path is globally unique. Temporarily move the
    // old mirror paths out of the way so the target copy can retain the
    // original storage path; any conflict in the target rolls the whole
    // transaction back.
    await transaction.unsafe(
      `update chat_documents documents
          set storage_path=documents.storage_path || ':project-move:' || documents.document_id
        where documents.owner_id=$1
          and documents.conversation_id=$2
          and documents.chat_project_id=$3
          and exists (
            select 1 from project_chat_move_documents moved
             where moved.owner_id=documents.owner_id
               and moved.conversation_id=documents.conversation_id
               and moved.document_id=documents.document_id
          )`,
      [ownerId, sourceLibraryConversationId, sourceProjectId],
    );

    await transaction.unsafe(
      `insert into chat_documents(
         owner_id,conversation_id,document_id,user_message_id,job_id,storage_path,
         filename,content_type,size,page_count,token_estimate,status,has_images,
         image_count,analyzed_image_count,image_analyses,project_id,revision_id,
         parent_revision_id,origin,editable,source_completeness,created_at,
         provider_metadata,chat_project_id,storage_object_id
       )
       select moved.owner_id,$2,moved.document_id,moved.user_message_id,moved.job_id,
              moved.storage_path,moved.filename,moved.content_type,moved.size,
              moved.page_count,moved.token_estimate,moved.status,moved.has_images,
              moved.image_count,moved.analyzed_image_count,moved.image_analyses,
              moved.project_id,moved.revision_id,moved.parent_revision_id,moved.origin,
              moved.editable,moved.source_completeness,moved.created_at,
              moved.provider_metadata,$3,moved.storage_object_id
         from project_chat_move_documents moved
        where moved.owner_id=$1 and moved.conversation_id=$4`,
      [ownerId, targetLibraryConversationId, targetProjectId, sourceLibraryConversationId],
    );

    await transaction.unsafe(
      `insert into chat_document_pages(
         owner_id,conversation_id,document_id,page_number,text,extraction_method,
         failure,markdown,provider_metadata
       )
       select pages.owner_id,$2,pages.document_id,pages.page_number,pages.text,
              pages.extraction_method,pages.failure,pages.markdown,pages.provider_metadata
         from chat_document_pages pages
         join project_chat_move_documents moved
           on moved.owner_id=pages.owner_id
          and moved.conversation_id=pages.conversation_id
          and moved.document_id=pages.document_id
        where pages.owner_id=$1 and pages.conversation_id=$3`,
      [ownerId, targetLibraryConversationId, sourceLibraryConversationId],
    );

    await transaction.unsafe(
      `insert into chat_document_images(
         owner_id,conversation_id,document_id,image_id,page_number,storage_object_id,
         storage_path,content_type,provider_metadata,created_at
       )
       select images.owner_id,$2,images.document_id,images.image_id,images.page_number,
              images.storage_object_id,images.storage_path,images.content_type,
              images.provider_metadata,images.created_at
         from chat_document_images images
         join project_chat_move_documents moved
           on moved.owner_id=images.owner_id
          and moved.conversation_id=images.conversation_id
          and moved.document_id=images.document_id
        where images.owner_id=$1 and images.conversation_id=$3`,
      [ownerId, targetLibraryConversationId, sourceLibraryConversationId],
    );

    await transaction.unsafe(
      `delete from chat_documents documents
        where documents.owner_id=$1
          and documents.conversation_id=$2
          and exists (
            select 1 from project_chat_move_documents moved
             where moved.owner_id=documents.owner_id
               and moved.conversation_id=documents.conversation_id
               and moved.document_id=documents.document_id
          )`,
      [ownerId, sourceLibraryConversationId],
    );
  }

  // Documents that are still attached directly to the moved chat do not need
  // a library copy. The library copies above already have the target project
  // metadata, while this updates the remaining source-conversation rows.
  await transaction.unsafe(
    `update chat_documents documents
        set chat_project_id=$3
      where documents.owner_id=$1
        and documents.conversation_id=$2
        and exists (
          select 1 from project_chat_move_documents moved
           where moved.owner_id=documents.owner_id
             and moved.conversation_id=documents.conversation_id
             and moved.document_id=documents.document_id
        )`,
    [ownerId, conversationId, targetProjectId],
  );

  if (sourceProjectId) {
    await transaction.unsafe(
      `update chat_project_images
          set project_id=$3,updated_at=now()
        where owner_id=$1 and project_id=$2 and conversation_id=$4`,
      [ownerId, sourceProjectId, targetProjectId, conversationId],
    );
  }

  // A null chat_project_id is eligible only when the source object is not a
  // source-backed document-project asset. Derived assets linked to a moved
  // chat document are included through the stable document-id snapshot.
  await transaction.unsafe(
    `update app_storage_objects objects
        set chat_project_id=$3
      where objects.owner_id=$1
        and objects.conversation_id=$2
        and (
          (
            objects.chat_project_id is not distinct from $4
            and (objects.chat_project_id is not null or objects.project_id is null)
          )
          or exists (
            select 1 from project_chat_move_documents moved
             where moved.owner_id=objects.owner_id
               and moved.document_id=objects.document_id
          )
        )`,
    [ownerId, conversationId, targetProjectId, sourceProjectId],
  );
}

/** Assign or move an existing owner-scoped conversation to a chat project. */
export async function assignProjectChat(input: {
  ownerId: string;
  projectId: string;
  conversationId: string;
  title?: string;
}): Promise<ChatProjectChat | null> {
  const owner = databaseOwnerId(input.ownerId);
  return withTransaction(async (transaction) => {
    const conversation = (await transaction.unsafe<{
      conversation_id: string;
      project_id: string | null;
      is_project_library: boolean;
    }>(
      `select conversation_id,project_id,is_project_library
         from chat_conversations
        where owner_id=$1 and conversation_id=$2
        for update`,
      [owner, input.conversationId],
    ))[0];
    if (conversation?.is_project_library) return null;

    const projectIds = [...new Set([conversation?.project_id, input.projectId].filter((value): value is string => Boolean(value)))].sort();
    const projects = await transaction.unsafe<{ project_id: string; deleting_at: unknown }>(
      `select project_id,deleting_at
         from chat_projects
        where owner_id=$1 and project_id=any($2::text[])
        order by project_id
        for update`,
      [owner, projectIds],
    );
    const targetProject = projects.find((project) => project.project_id === input.projectId);
    if (!targetProject || targetProject.deleting_at !== null) return null;
    if (conversation?.project_id && !projects.some((project) => project.project_id === conversation?.project_id)) return null;

    if (!conversation) {
      const [created] = await transaction.unsafe<ProjectChatRow>(
        `insert into chat_conversations(owner_id,conversation_id,project_id,title)
         values($1,$2,$3,coalesce($4,'New conversation'))
         returning conversation_id,project_id,title,created_at,updated_at,
           false as has_messages,
           false as is_streaming`,
        [owner, input.conversationId, input.projectId, input.title ?? null],
      );
      if (!created) return null;

      await transaction.unsafe(
        "update chat_projects set updated_at=now() where owner_id=$1 and project_id=any($2::text[])",
        [owner, projectIds],
      );
      return projectChatFromRow(created);
    }

    if (conversation.project_id !== input.projectId) {
      await moveProjectChatResources({
        transaction,
        ownerId: owner,
        conversationId: input.conversationId,
        sourceProjectId: conversation.project_id,
        targetProjectId: input.projectId,
      });
    }

    const [updated] = await transaction.unsafe<ProjectChatRow>(
      `update chat_conversations
          set project_id=$1,title=coalesce($2,title),updated_at=now()
        where owner_id=$3 and conversation_id=$4 and not is_project_library
        returning conversation_id,project_id,title,created_at,updated_at,
          exists(select 1 from chat_messages m where m.owner_id=chat_conversations.owner_id and m.conversation_id=chat_conversations.conversation_id) as has_messages,
          exists(select 1 from chat_messages m where m.owner_id=chat_conversations.owner_id and m.conversation_id=chat_conversations.conversation_id and m.role='assistant' and m.status='streaming') as is_streaming`,
      [input.projectId, input.title ?? null, owner, input.conversationId],
    );
    if (!updated) return null;

    await transaction.unsafe(
      "update chat_projects set updated_at=now() where owner_id=$1 and project_id=any($2::text[])",
      [owner, projectIds],
    );
    return projectChatFromRow(updated);
  });
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
