"use client";

import { authFetch } from "../auth/auth-fetch";
import type { Project, ProjectChat, ProjectDetail, ProjectFile } from "./project-types";

type ErrorBody = { error?: string };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorBody;
    throw new Error(body.error || fallback);
  }
  return response.json() as Promise<T>;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function listProjects(): Promise<Project[]> {
  const response = await authFetch("/api/projects");
  return (await readJson<{ projects: Project[] }>(response, "Projects are unavailable.")).projects;
}

export async function createProject(title: string): Promise<Project> {
  const response = await authFetch("/api/projects", jsonRequest("POST", { title, instructions: "" }));
  return (await readJson<{ project: Project }>(response, "The project could not be created.")).project;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  const root = `/api/projects/${encodeURIComponent(projectId)}`;
  const [projectResponse, chatsResponse, filesResponse] = await Promise.all([
    authFetch(root),
    authFetch(`${root}/chats`),
    authFetch(`${root}/files`),
  ]);
  const [{ project }, { chats }, { files }] = await Promise.all([
    readJson<{ project: Project }>(projectResponse, "The project is unavailable."),
    readJson<{ chats: ProjectChat[] }>(chatsResponse, "Project chats are unavailable."),
    readJson<{ files: ProjectFile[] }>(filesResponse, "Project files are unavailable."),
  ]);
  return { project, chats, files };
}

export async function updateProject(projectId: string, changes: Partial<Pick<Project, "title" | "instructions">>): Promise<Project> {
  const response = await authFetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonRequest("PATCH", changes));
  return (await readJson<{ project: Project }>(response, "The project could not be updated.")).project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await authFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!response.ok) await readJson(response, "The project could not be deleted.");
}

export async function createProjectChat(projectId: string): Promise<ProjectChat> {
  const response = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/chats`, jsonRequest("POST", {}));
  return (await readJson<{ chat: ProjectChat }>(response, "The chat could not be created.")).chat;
}

export async function assignChatToProject(projectId: string, conversationId: string, title: string): Promise<ProjectChat> {
  const response = await authFetch(
    `/api/projects/${encodeURIComponent(projectId)}/chats`,
    jsonRequest("POST", { conversationId, title }),
  );
  return (await readJson<{ chat: ProjectChat }>(response, "The chat could not be added to the project.")).chat;
}

export async function deleteProjectFile(projectId: string, fileId: string): Promise<void> {
  const response = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  if (!response.ok) await readJson(response, "The file could not be deleted.");
}

export function projectFileUrl(projectId: string, fileId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
}
