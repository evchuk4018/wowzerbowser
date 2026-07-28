import type { ChatStartupSnapshotV1 } from "../../lib/chat-startup-snapshot";

const DATABASE_NAME = "wowzerbowser-chat";
const DATABASE_VERSION = 1;
const STORE_NAME = "startup-snapshots";

function indexedDbAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openSnapshotDatabase(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      finish(database);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

export async function readChatStartupSnapshot(userId: string): Promise<unknown | null> {
  const database = await openSnapshotDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    let finished = false;
    const close = () => {
      if (!finished) {
        finished = true;
        database.close();
      }
    };
    try {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(userId);
      request.onsuccess = () => {
        const value = request.result ?? null;
        close();
        resolve(value);
      };
      request.onerror = () => {
        close();
        resolve(null);
      };
    } catch {
      close();
      resolve(null);
    }
  });
}

export async function writeChatStartupSnapshot(snapshot: ChatStartupSnapshotV1): Promise<void> {
  const database = await openSnapshotDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const close = () => {
      if (!finished) {
        finished = true;
        database.close();
      }
    };
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.oncomplete = () => {
        close();
        resolve();
      };
      transaction.onerror = () => {
        close();
        resolve();
      };
      transaction.onabort = () => {
        close();
        resolve();
      };
      transaction.objectStore(STORE_NAME).put(snapshot);
    } catch {
      close();
      resolve();
    }
  });
}

export async function deleteChatStartupSnapshot(userId: string): Promise<void> {
  const database = await openSnapshotDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const close = () => {
      if (!finished) {
        finished = true;
        database.close();
      }
    };
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.oncomplete = () => {
        close();
        resolve();
      };
      transaction.onerror = () => {
        close();
        resolve();
      };
      transaction.onabort = () => {
        close();
        resolve();
      };
      transaction.objectStore(STORE_NAME).delete(userId);
    } catch {
      close();
      resolve();
    }
  });
}
