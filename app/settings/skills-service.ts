"use client";

import type { SkillDefinition, SkillMutation } from "../../lib/skill-protocol";
import { authFetch } from "../auth/auth-fetch";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The skills request failed.");
  return body;
}

const headers = (content = false) => ({
  ...(content ? { "content-type": "application/json" } : {}),
});

export async function fetchSkills(): Promise<SkillDefinition[]> {
  const response = await authFetch("/api/skills", { headers: headers(), cache: "no-store" });
  return (await json<{ skills: SkillDefinition[] }>(response)).skills;
}

export async function createSkill(input: SkillMutation): Promise<SkillDefinition> {
  const response = await authFetch("/api/skills", {
    method: "POST", headers: headers(true), body: JSON.stringify(input),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function updateSkill(id: string, input: SkillMutation): Promise<SkillDefinition> {
  const response = await authFetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: headers(true), body: JSON.stringify(input),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function resetSkill(id: string): Promise<SkillDefinition> {
  const response = await authFetch(`/api/skills/${encodeURIComponent(id)}/reset`, {
    method: "POST", headers: headers(),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function deleteSkill(id: string): Promise<void> {
  await json(await authFetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: headers(),
  }));
}
