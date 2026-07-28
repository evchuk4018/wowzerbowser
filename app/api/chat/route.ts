import { after } from "next/server";
import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { parseChatRequest, ChatRequestValidationError } from "../../../lib/chat-protocol";
import { DeepSeekError } from "../../providers/deepseek/deepseek-adapter";
import { authorizeChatModel, ChatModelAuthorizationError } from "../../server/chat/chat-model-catalog-service";
import { chatProviderAdapter } from "../../server/chat/chat-provider-registry";
import { createOrGetChatJob } from "../../server/chat/chat-job-store";
import { runChatJob } from "../../server/chat/chat-job-runner";
import { encodeChatLiveEnvelope } from "../../server/chat/encode-chat-live-envelope";
import { processChatSummaryForCompletedJob } from "../../server/chat/chat-summary-service";
import type { ChatLiveStreamEnvelope } from "../../../lib/chat-protocol";

export const maxDuration = 300;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return unauthorized();
  if (Number(request.headers.get("content-length") ?? "0") > 1_250_000) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return unauthorized();
  try {
    const chatRequest = parseChatRequest(await request.json());
    if (!chatRequest.conversationId || !chatRequest.jobId || !chatRequest.idempotencyKey || !chatRequest.persistence) {
      return NextResponse.json({ error: "conversationId, jobId, idempotencyKey, and persistence are required." }, { status: 400 });
    }
    const selectedModel = await authorizeChatModel(user.id, chatRequest.model);
    if (selectedModel.reasoningRequired && !chatRequest.thinking) return NextResponse.json({ error: "Reasoning is required for this model." }, { status: 400 });
    if (chatRequest.thinking && !selectedModel.supportedEfforts.includes(chatRequest.reasoningEffort)) return NextResponse.json({ error: "Reasoning effort is not supported." }, { status: 400 });
    chatProviderAdapter(chatRequest.model.provider).assertConfigured();
    const submission = await createOrGetChatJob(user.id, chatRequest);
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let deliveryOpen = true;
    const failDelivery = (error: Error) => {
      const controller = streamController;
      deliveryOpen = false;
      streamController = null;
      try {
        controller?.error(error);
      } catch {
        // The response was already closed by its consumer.
      }
    };
    const send = (envelope: ChatLiveStreamEnvelope) => {
      if (!deliveryOpen || !streamController) return;
      if (streamController.desiredSize !== null && streamController.desiredSize <= 0) {
        failDelivery(new Error("Live delivery fell behind; resuming from durable storage."));
        return;
      }
      try {
        streamController.enqueue(encodeChatLiveEnvelope(envelope));
      } catch {
        failDelivery(new Error("Live delivery closed; resuming from durable storage."));
      }
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streamController = controller;
          send({ type: "submission", submission });
        },
        cancel() {
          deliveryOpen = false;
          streamController = null;
        },
      },
      { highWaterMark: 64 },
    );

    const execution = submission.resumed
      ? Promise.resolve()
      : runChatJob(user.id, chatRequest.conversationId, submission.jobId, {
          ...(submission.request ? { claimedRequest: submission.request } : {}),
          onEvent: (event) => send({ type: "event", event }),
        })
          .then((terminal) => {
            if (terminal) send({ type: "terminal", terminal });
          })
          .catch((error: unknown) => {
            send({
              type: "terminal",
              terminal: {
                jobId: submission.jobId,
                status: "failed",
                error: error instanceof Error ? error.message : "Generation failed.",
                usage: null,
                finalOutput: "",
              },
            });
          });
    const completion = execution.finally(() => {
      if (!deliveryOpen || !streamController) return;
      deliveryOpen = false;
      streamController.close();
      streamController = null;
    });
    after(() => completion);
    after(async () => {
      await completion;
      await processChatSummaryForCompletedJob(user.id, chatRequest.conversationId!, submission.jobId).catch(() => undefined);
    });

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
