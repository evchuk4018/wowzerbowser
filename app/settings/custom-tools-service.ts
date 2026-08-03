"use client";

import type {
  CustomToolDefinition, CustomToolMutation, CustomToolSummary, CustomToolTestResult,
} from "../../lib/custom-tool-protocol";
import { authFetch } from "../auth/auth-fetch";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The tools request failed.");
  return body;
}

export async function fetchCustomTools(): Promise<CustomToolSummary[]> {
  return (await responseJson<{ tools: CustomToolSummary[] }>(await authFetch("/api/tools", {
    cache: "no-store",
  }))).tools;
}

export async function fetchCustomTool(id: string): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await authFetch(`/api/tools/${id}`, {
    cache: "no-store",
  }))).tool;
}

export async function createCustomTool(values: CustomToolMutation): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await authFetch("/api/tools", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  }))).tool;
}

export async function updateCustomTool(id: string, values: CustomToolMutation): Promise<CustomToolDefinition> {
  return (await responseJson<{ tool: CustomToolDefinition }>(await authFetch(`/api/tools/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  }))).tool;
}

export async function deleteCustomTool(id: string): Promise<void> {
  const response = await authFetch(`/api/tools/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "The tool could not be deleted.");
}

export async function testCustomTool(id: string, input: unknown): Promise<CustomToolTestResult> {
  return (await responseJson<{ result: CustomToolTestResult }>(await authFetch(`/api/tools/${id}/test`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  }))).result;
}
