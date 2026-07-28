"use client";

import type {
  CustomToolDefinition, CustomToolMutation, CustomToolSummary, CustomToolTestResult,
} from "../../lib/custom-tool-protocol";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The tools request failed.");
  return body;
}

export async function fetchCustomTools(token: string): Promise<CustomToolSummary[]> {
  return (await responseJson<{ tools: CustomToolSummary[] }>(await fetch("/api/tools", {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store",
  }))).tools;
}

export async function fetchCustomTool(id: string, token: string): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await fetch(`/api/tools/${id}`, {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store",
  }))).tool;
}

export async function createCustomTool(values: CustomToolMutation, token: string): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await fetch("/api/tools", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(values),
  }))).tool;
}

export async function updateCustomTool(id: string, values: CustomToolMutation, token: string): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await fetch(`/api/tools/${id}`, {
    method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(values),
  }))).tool;
}

export async function deleteCustomTool(id: string, token: string): Promise<void> {
  const response = await fetch(`/api/tools/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "The tool could not be deleted.");
}

export async function testCustomTool(id: string, input: unknown, token: string): Promise<CustomToolTestResult> {
  return (await responseJson<{ result: CustomToolTestResult }>(await fetch(`/api/tools/${id}/test`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ input }),
  }))).result;
}
