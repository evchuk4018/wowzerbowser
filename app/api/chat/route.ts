import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { parseChatRequest, ChatRequestValidationError } from "../../../lib/chat-protocol";
import { DeepSeekError } from "../../providers/deepseek/deepseek-adapter";
import { authorizeChatModel, ChatModelAuthorizationError } from "../../server/chat/chat-model-catalog-service";
import { chatProviderAdapter } from "../../server/chat/chat-provider-registry";
import { createOrGetChatJob } from "../../server/chat/chat-job-store";
import { streamChatJob } from "../../server/chat/chat-job-stream";
import { ensureRuntimeConfigLoaded } from "../../server/config/runtime-config-service";
import { prepareAbTestExecution } from "../../server/ab-testing/ab-test-execution-service";

export const maxDuration = 300;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? "0") > 1_250_000) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  const user = await authorizeOwnerSession(request);
  if (!user) return unauthorized();
  try {
    await ensureRuntimeConfigLoaded(user.id);
    const chatRequest = parseChatRequest(await request.json());
    if (!chatRequest.conversationId || !chatRequest.jobId || !chatRequest.idempotencyKey || !chatRequest.persistence) {
      return NextResponse.json({ error: "conversationId, jobId, idempotencyKey, and persistence are required." }, { status: 400 });
    }
    let abTest: Awaited<ReturnType<typeof prepareAbTestExecution>> = null;
    try {
      abTest = await prepareAbTestExecution(user.id, chatRequest);
    } catch (error) {
      // A/B testing is optional for the normal chat path. A deployment with
      // the feature migration still pending must continue to accept chats.
      console.warn({ event: "ab-test-selection-unavailable", failure: error instanceof Error ? error.name : "UnknownError" });
    }
    const effectiveRequest = abTest
      ? {
          ...chatRequest,
          systemPrompt: abTest.variantA.snapshot.systemPrompt,
          userPresence: abTest.variantA.snapshot.userPresence,
          model: abTest.variantA.snapshot.model,
          thinking: abTest.variantA.snapshot.thinking,
          reasoningEffort: abTest.variantA.snapshot.reasoningEffort,
          contextMode: abTest.variantA.snapshot.contextMode,
          mode: abTest.variantA.snapshot.mode,
          abTest,
        }
      : chatRequest;
    const selectedModel = await authorizeChatModel(user.id, effectiveRequest.model);
    if (selectedModel.reasoningRequired && !effectiveRequest.thinking) return NextResponse.json({ error: "Reasoning is required for this model." }, { status: 400 });
    if (effectiveRequest.thinking && !selectedModel.supportedEfforts.includes(effectiveRequest.reasoningEffort)) return NextResponse.json({ error: "Reasoning effort is not supported." }, { status: 400 });
    chatProviderAdapter(effectiveRequest.model.provider).assertConfigured();
    const submission = await createOrGetChatJob(user.id, effectiveRequest);
    const stream = streamChatJob(user.id, chatRequest.conversationId, submission, request.signal);
    return new Response(stream, {
      status: submission.resumed ? 200 : 202,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof ChatRequestValidationError || error instanceof ChatModelAuthorizationError || error instanceof SyntaxError) return NextResponse.json({ error: error.message }, { status: 400 });
    const status = error instanceof DeepSeekError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chat storage is unavailable." }, { status });
  }
}
