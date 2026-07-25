import "server-only";

import { ModalClient, NotFoundError } from "modal";
import {
  MODAL_APP_NAME,
  conversationVolumeName,
  isModalConfigured,
  responseSandboxName,
} from "./modal-python-executor";

/** Remove all provider-owned resources associated with one conversation. */
export async function deleteConversationWorkspace(ownerId: string, conversationId: string): Promise<void> {
  if (!isModalConfigured()) throw new Error("Modal workspace cleanup is unavailable.");

  const client = new ModalClient();
  try {
    try {
      const sandbox = await client.sandboxes.fromName(
        MODAL_APP_NAME,
        responseSandboxName(ownerId, conversationId),
      );
      await sandbox.terminate();
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    await client.volumes.delete(conversationVolumeName(ownerId, conversationId), {
      allowMissing: true,
    });
  } finally {
    client.close();
  }
}
