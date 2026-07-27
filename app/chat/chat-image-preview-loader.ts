import { ChatImageFetchError } from "./chat-service";

export const CHAT_IMAGE_PREVIEW_DELAYS_MS = [200, 400, 800, 1_600] as const;
const TRANSIENT_STATUSES = new Set([404, 409, 503]);

export async function loadChatImagePreview(input: {
  imageId: string;
  conversationId: string;
  signal: AbortSignal;
  getAccessToken: () => Promise<string | null>;
  fetchImage: (imageId: string, conversationId: string, token: string, signal: AbortSignal) => Promise<Blob>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<Blob> {
  const wait = input.wait ?? abortableDelay;
  for (let attempt = 0; ; attempt += 1) {
    input.signal.throwIfAborted();
    const token = await input.getAccessToken();
    input.signal.throwIfAborted();
    if (!token) throw new ChatImageFetchError(401, "Authentication is required.");
    try {
      return await input.fetchImage(input.imageId, input.conversationId, token, input.signal);
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (!(error instanceof ChatImageFetchError)
        || !TRANSIENT_STATUSES.has(error.status)
        || attempt >= CHAT_IMAGE_PREVIEW_DELAYS_MS.length) throw error;
      await wait(CHAT_IMAGE_PREVIEW_DELAYS_MS[attempt], input.signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
