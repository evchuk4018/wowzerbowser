import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";
import { WORKSPACE_LIMITS } from "../../../lib/workspace-protocol";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { INSPECT_WORKSPACE_PDF_TOOL_DEFINITION } from "./workspace-pdf-tool-manifest";

export const WORKSPACE_LIST_TOOL_NAME = "workspace_list";
export const WORKSPACE_SEARCH_TOOL_NAME = "workspace_search";
export const WORKSPACE_READ_TOOL_NAME = "workspace_read";
export const WORKSPACE_WRITE_TOOL_NAME = "workspace_write";
export const WORKSPACE_PATCH_TOOL_NAME = "workspace_patch";
export const WORKSPACE_DELETE_TOOL_NAME = "workspace_delete";
export const RUN_COMMAND_TOOL_NAME = "run_command";

const path = { type: "string", minLength: 1, maxLength: WORKSPACE_LIMITS.maxPathLength };

export function configuredWorkspaceSearchDefaultResults(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceSearchDefaultResults;
  const maximum = configuredWorkspaceSearchMaxResults();
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(maximum, value))
    : Math.min(maximum, 50);
}

export function configuredWorkspaceSearchMaxResults(): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>).workspaceSearchMaxResults;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(WORKSPACE_LIMITS.maxSearchResults, value))
    : WORKSPACE_LIMITS.maxSearchResults;
}

export function workspaceToolDefinitions(): ModelToolDefinition[] {
  const defaultResults = configuredWorkspaceSearchDefaultResults();
  const maximumResults = configuredWorkspaceSearchMaxResults();
  return [
    { type: "function", function: { name: WORKSPACE_LIST_TOOL_NAME, description: "List files in the persistent conversation workspace. Inspect before creating or editing files.", parameters: { type: "object", additionalProperties: false, properties: { path: { ...path, description: "Directory path, usually '.' or a relative directory." } } } } },
    { type: "function", function: { name: WORKSPACE_SEARCH_TOOL_NAME, description: `Search filenames and text contents in the persistent conversation workspace and return up to ${defaultResults} matches by default.`, parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: WORKSPACE_LIMITS.maxSearchQueryLength }, path: { ...path }, maxResults: { type: "integer", minimum: 1, maximum: maximumResults, default: defaultResults } } } } },
    { type: "function", function: { name: WORKSPACE_READ_TOOL_NAME, description: "Read an existing workspace file, optionally restricting output to one-based inclusive line numbers.", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } } } },
    { type: "function", function: { name: WORKSPACE_WRITE_TOOL_NAME, description: "Create or replace a text file in the workspace. Reuse existing files and provide expectedSha256 when editing a file you previously read.", parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path, content: { type: "string", maxLength: WORKSPACE_LIMITS.maxWriteBytes }, expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } } } },
    { type: "function", function: { name: WORKSPACE_PATCH_TOOL_NAME, description: "Make a targeted edit to an existing text file. Use oldText/newText for an exact replacement or patch for a unified diff, and verify expected occurrences.", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path, oldText: { type: "string", maxLength: 65536 }, newText: { type: "string", maxLength: 65536 }, patch: { type: "string", maxLength: 65536 }, expectedOccurrences: { type: "integer", minimum: 0, maximum: 100 }, expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } } } },
    { type: "function", function: { name: WORKSPACE_DELETE_TOOL_NAME, description: "Delete an existing workspace file after confirming the exact path.", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path } } } },
    { type: "function", function: { name: RUN_COMMAND_TOOL_NAME, description: "Run a bounded command inside the persistent conversation workspace. Use argv-style command and args, never a host path or an unrestricted shell string.", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 128 }, args: { type: "array", items: { type: "string", maxLength: WORKSPACE_LIMITS.maxCommandArgLength }, maxItems: WORKSPACE_LIMITS.maxCommandArgs }, cwd: { ...path }, stdin: { type: "string", maxLength: 65536 }, timeoutMs: { type: "integer", minimum: 100, maximum: WORKSPACE_LIMITS.maxCommandTimeoutMs } } } } },
    INSPECT_WORKSPACE_PDF_TOOL_DEFINITION,
  ];
}

export const WORKSPACE_TOOL_DEFINITIONS = workspaceToolDefinitions();

export function availableWorkspaceTools(enabled: boolean): ModelToolDefinition[] {
  return enabled ? workspaceToolDefinitions() : [];
}
