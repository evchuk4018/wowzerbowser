import "server-only";
import type { ChatStreamEvent, ChatUsage } from "../../../lib/chat-protocol";
import { generateChatResponse } from "../../chat/chat-server-service";
import { appendChatJobEvent, claimChatJob, finishChatJob, isChatJobCancelled } from "./chat-job-store";

/** Runs from Next's server-owned `after` lifecycle, never from the request signal. */
export async function runChatJob(ownerId: string, conversationId: string, jobId: string) {
  const request = await claimChatJob(ownerId, conversationId, jobId);
  if (!request) return; // another route instance already claimed this idempotent job
  const controller = new AbortController();
  const poll = setInterval(() => void isChatJobCancelled(ownerId, conversationId, jobId).then((cancelled) => cancelled && controller.abort()), 750);
  let output = "";
  let usage: ChatUsage | null = null;
  let generationError: string | null = null;
  try {
    await generateChatResponse(request, ownerId, controller.signal, async (event: ChatStreamEvent) => {
      await appendChatJobEvent(ownerId, conversationId, jobId, event);
      if (event.type === "content") output += event.delta;
      if (event.type === "done") usage = event.usage;
      if (event.type === "error") generationError = event.message;
    });
    if (!controller.signal.aborted) {
      await finishChatJob(ownerId, conversationId, jobId, generationError ? "failed" : "completed", { error: generationError, usage, finalOutput: output });
    }
  } catch (error) {
    if (!controller.signal.aborted) await finishChatJob(ownerId, conversationId, jobId, "failed", { error: error instanceof Error ? error.message : "Generation failed.", finalOutput: output });
  } finally {
    clearInterval(poll);
  }
}
