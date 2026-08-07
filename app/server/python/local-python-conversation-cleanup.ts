import "server-only";

import { currentPythonWorkerUrl, isLocalPythonConfigured } from "./local-python-executor";

/** Remove the private local worker workspace associated with one conversation. */
export async function deleteConversationWorkspace(ownerId: string, conversationId: string, workspaceId = conversationId): Promise<void> {
  if (!isLocalPythonConfigured()) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL("/v1/workspace/delete", `${currentPythonWorkerUrl().replace(/\/+$/u, "")}/`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-python-worker-secret": process.env.PYTHON_WORKER_SECRET?.trim() ?? "",
      },
      body: JSON.stringify({ ownerId, conversationId, workspaceId }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Local Python workspace cleanup failed with status ${response.status}.`);
  } finally {
    clearTimeout(timeout);
  }
}
