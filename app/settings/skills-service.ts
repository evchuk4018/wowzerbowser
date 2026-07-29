"use client";

import type { SkillDefinition, SkillMutation } from "../../lib/skill-protocol";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The skills request failed.");
  return body;
}

const headers = (token: string, content = false) => ({
  authorization: `Bearer ${token}`,
  ...(content ? { "content-type": "application/json" } : {}),
});

export async function fetchSkills(token: string): Promise<SkillDefinition[]> {
  const response = await fetch("/api/skills", { headers: headers(token), cache: "no-store" });
  return (await json<{ skills: SkillDefinition[] }>(response)).skills;
}

export async function createSkill(input: SkillMutation, token: string): Promise<SkillDefinition> {
  const response = await fetch("/api/skills", {
    method: "POST", headers: headers(token, true), body: JSON.stringify(input),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function updateSkill(id: string, input: SkillMutation, token: string): Promise<SkillDefinition> {
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: headers(token, true), body: JSON.stringify(input),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function resetSkill(id: string, token: string): Promise<SkillDefinition> {
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}/reset`, {
    method: "POST", headers: headers(token),
  });
  return (await json<{ skill: SkillDefinition }>(response)).skill;
}

export async function deleteSkill(id: string, token: string): Promise<void> {
  await json(await fetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: headers(token),
  }));
}
