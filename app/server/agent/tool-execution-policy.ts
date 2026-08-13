import type { ConnectorTool } from "../../../lib/connector-protocol";
import {
  CHECK_DATE_TOOL_NAME,
  CHECK_LOCATION_TOOL_NAME,
  CHECK_TIME_TOOL_NAME,
  FETCH_PAGE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./web-tools";
import { INSPECT_IMAGE_TOOL_NAME } from "./image-tool-manifest";
import { INSPECT_WORKSPACE_IMAGE_TOOL_NAME } from "./workspace-image-tool-manifest";
import { INSPECT_WORKSPACE_PDF_TOOL_NAME } from "./workspace-pdf-tool-manifest";
import { INSPECT_DOCUMENT_PAGE_TOOL_NAME, INSPECT_DOCUMENT_PAGES_TOOL_NAME, READ_PDF_PAGES_TOOL_NAME, SEARCH_PDF_TOOL_NAME } from "./pdf-tool-manifest";
import {
  COMPARE_DOCUMENT_REVISIONS_TOOL_NAME,
  EDIT_PDF_TOOL_NAME,
  EDIT_SOURCE_BACKED_DOCUMENT_TOOL_NAME,
  INSPECT_PDF_EDITABILITY_TOOL_NAME,
} from "./pdf-edit-tool-manifest";
import {
  DEEP_RESEARCH_SEARCH_TOOL_NAME,
  FIND_IN_PAGE_TOOL_NAME,
  FOLLOW_PAGE_LINK_TOOL_NAME,
  LIST_PAGE_LINKS_TOOL_NAME,
} from "./deep-research-tool-manifest";
import { SEARCH_CHATS_TOOL_NAME } from "./chat-memory-tool-manifest";
import {
  ADD_USER_MEMORY_TOOL,
  BROWSE_USER_MEMORY_TOOL,
  CREATE_MEMORY_FOLDER_TOOL,
  DELETE_USER_MEMORY_TOOL,
  EDIT_USER_MEMORY_TOOL,
  MOVE_USER_MEMORY_TOOL,
  READ_USER_MEMORY_TOOL,
} from "./user-memory-tool-manifest";
import { READ_SKILL_TOOL_NAME } from "./skill-tool-manifest";
import { AUTOMATION_TOOL_NAMES, REMINDER_TOOL_NAMES } from "./automation-tool-manifest";
import { CALENDAR_TOOL_NAMES } from "./calendar-tool-manifest";
import { GET_TODOS_TOOL_NAME } from "./todo-tool";
import { SEARCH_CURRENT_CHAT_TOOL_NAME } from "./current-chat-context-tool-manifest";
import {
  RUN_COMMAND_TOOL_NAME,
  WORKSPACE_DELETE_TOOL_NAME,
  WORKSPACE_PATCH_TOOL_NAME,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_SEARCH_TOOL_NAME,
  WORKSPACE_LIST_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAME,
} from "./workspace-tool-manifest";
import { RUN_SUBAGENT_TOOL_NAME } from "./subagent-tool-manifest";

export type ToolExecutionPolicy = "parallel-safe" | "serial";
export type ToolExecutionMetadata = { executionPolicy: ToolExecutionPolicy };

/**
 * Only tools whose implementation is read-only and independent are allowed
 * into a concurrent batch. Unknown, custom, and stateful tools stay serial by
 * default so adding a new tool cannot accidentally introduce a race.
 */
export const TOOL_EXECUTION_METADATA: Readonly<Record<string, ToolExecutionMetadata>> = {
  [WEB_SEARCH_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [FETCH_PAGE_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [CHECK_TIME_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [CHECK_DATE_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [CHECK_LOCATION_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_IMAGE_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_WORKSPACE_IMAGE_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_WORKSPACE_PDF_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [SEARCH_PDF_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [READ_PDF_PAGES_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_DOCUMENT_PAGE_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_DOCUMENT_PAGES_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [INSPECT_PDF_EDITABILITY_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [COMPARE_DOCUMENT_REVISIONS_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [FIND_IN_PAGE_TOOL_NAME]: { executionPolicy: "serial" },
  [LIST_PAGE_LINKS_TOOL_NAME]: { executionPolicy: "serial" },
  [FOLLOW_PAGE_LINK_TOOL_NAME]: { executionPolicy: "serial" },
  [DEEP_RESEARCH_SEARCH_TOOL_NAME]: { executionPolicy: "serial" },
  [RUN_SUBAGENT_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [SEARCH_CHATS_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [BROWSE_USER_MEMORY_TOOL]: { executionPolicy: "parallel-safe" },
  [READ_USER_MEMORY_TOOL]: { executionPolicy: "parallel-safe" },
  [READ_SKILL_TOOL_NAME]: { executionPolicy: "serial" },
  [AUTOMATION_TOOL_NAMES.list]: { executionPolicy: "parallel-safe" },
  [AUTOMATION_TOOL_NAMES.get]: { executionPolicy: "parallel-safe" },
  [CALENDAR_TOOL_NAMES.list]: { executionPolicy: "parallel-safe" },
  [CALENDAR_TOOL_NAMES.get]: { executionPolicy: "parallel-safe" },
  [GET_TODOS_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [SEARCH_CURRENT_CHAT_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [WORKSPACE_LIST_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [WORKSPACE_SEARCH_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [WORKSPACE_READ_TOOL_NAME]: { executionPolicy: "parallel-safe" },
  [RUN_COMMAND_TOOL_NAME]: { executionPolicy: "serial" },
  [WORKSPACE_WRITE_TOOL_NAME]: { executionPolicy: "serial" },
  [WORKSPACE_PATCH_TOOL_NAME]: { executionPolicy: "serial" },
  [WORKSPACE_DELETE_TOOL_NAME]: { executionPolicy: "serial" },
  [EDIT_SOURCE_BACKED_DOCUMENT_TOOL_NAME]: { executionPolicy: "serial" },
  [EDIT_PDF_TOOL_NAME]: { executionPolicy: "serial" },
  [ADD_USER_MEMORY_TOOL]: { executionPolicy: "serial" },
  [CREATE_MEMORY_FOLDER_TOOL]: { executionPolicy: "serial" },
  [EDIT_USER_MEMORY_TOOL]: { executionPolicy: "serial" },
  [MOVE_USER_MEMORY_TOOL]: { executionPolicy: "serial" },
  [DELETE_USER_MEMORY_TOOL]: { executionPolicy: "serial" },
  [AUTOMATION_TOOL_NAMES.create]: { executionPolicy: "serial" },
  [AUTOMATION_TOOL_NAMES.update]: { executionPolicy: "serial" },
  [AUTOMATION_TOOL_NAMES.delete]: { executionPolicy: "serial" },
  [REMINDER_TOOL_NAMES.list]: { executionPolicy: "parallel-safe" },
  [REMINDER_TOOL_NAMES.get]: { executionPolicy: "parallel-safe" },
  [REMINDER_TOOL_NAMES.create]: { executionPolicy: "serial" },
  [REMINDER_TOOL_NAMES.update]: { executionPolicy: "serial" },
  [REMINDER_TOOL_NAMES.cancel]: { executionPolicy: "serial" },
  [CALENDAR_TOOL_NAMES.create]: { executionPolicy: "serial" },
  [CALENDAR_TOOL_NAMES.update]: { executionPolicy: "serial" },
  [CALENDAR_TOOL_NAMES.delete]: { executionPolicy: "serial" },
  ["complete_todo"]: { executionPolicy: "serial" },
  ["recall_chats"]: { executionPolicy: "serial" },
  ["run_python"]: { executionPolicy: "serial" },
  ["phase_break"]: { executionPolicy: "serial" },
  ["search_connector_tools"]: { executionPolicy: "serial" },
  ["complete_automation_run"]: { executionPolicy: "serial" },
} as const;

export function toolExecutionMetadata(
  toolName: string,
  connectorTools: readonly ConnectorTool[] = [],
): ToolExecutionMetadata {
  if (toolName.startsWith("connector__")) {
    const connectorTool = connectorTools.find((tool) => tool.namespacedName === toolName);
    return { executionPolicy: connectorTool?.access === "read" ? "parallel-safe" : "serial" };
  }
  return TOOL_EXECUTION_METADATA[toolName] ?? { executionPolicy: "serial" };
}

export function planToolBatches<T>(
  calls: readonly T[],
  policyFor: (call: T) => ToolExecutionPolicy,
): T[][] {
  const batches: T[][] = [];
  let parallelBatch: T[] = [];
  const flushParallelBatch = (): void => {
    if (!parallelBatch.length) return;
    batches.push(parallelBatch);
    parallelBatch = [];
  };

  for (const call of calls) {
    if (policyFor(call) === "parallel-safe") parallelBatch.push(call);
    else {
      flushParallelBatch();
      batches.push([call]);
    }
  }
  flushParallelBatch();
  return batches;
}

const DEFAULT_CONCURRENCY = 4;

export async function executeToolBatch<T, R>(
  calls: readonly T[],
  execute: (call: T) => Promise<R>,
  signal: AbortSignal,
  concurrency = DEFAULT_CONCURRENCY,
  onSettled?: (outcome: PromiseSettledResult<R>, index: number) => Promise<void> | void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(calls.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), calls.length || 1));
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= calls.length) return;
      if (signal.aborted) {
        results[index] = { status: "rejected", reason: signal.reason ?? new DOMException("The tool batch was cancelled.", "AbortError") };
        await onSettled?.(results[index], index);
        continue;
      }
      try {
        results[index] = { status: "fulfilled", value: await execute(calls[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      await onSettled?.(results[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
