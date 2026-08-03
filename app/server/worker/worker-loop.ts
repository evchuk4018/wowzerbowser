export type WorkerLoopDependencies<ChatClaim, DocumentClaim> = {
  claimChat: () => Promise<ChatClaim | null>;
  executeChat: (claim: ChatClaim, shutdownSignal: AbortSignal) => Promise<unknown>;
  claimDocument: () => Promise<DocumentClaim | null>;
  executeDocument: (claim: DocumentClaim, shutdownSignal: AbortSignal) => Promise<unknown>;
  maintenance?: () => Promise<unknown>;
  pollIntervalMs?: number;
  maintenanceIntervalMs?: number;
  chatConcurrency?: number;
  documentConcurrency?: number;
  onTaskError?: (kind: "chat" | "document" | "maintenance", error: unknown) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Worker shutdown requested."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value as number)) : fallback;
}

/**
 * Small single-process supervisor. PostgreSQL owns all durable state; this
 * loop only owns in-memory slots and abort signals for graceful shutdown.
 */
export class BackgroundWorkerLoop<ChatClaim, DocumentClaim> {
  private readonly shutdownController = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly chatConcurrency: number;
  private readonly documentConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly onTaskError: (kind: "chat" | "document" | "maintenance", error: unknown) => void;
  private stopped = false;
  private runningChats = 0;
  private runningDocuments = 0;
  private maintenanceRunning = false;
  private lastMaintenanceAt = 0;

  constructor(private readonly dependencies: WorkerLoopDependencies<ChatClaim, DocumentClaim>) {
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.chatConcurrency = bounded(dependencies.chatConcurrency, 1, 1, 1);
    this.documentConcurrency = bounded(dependencies.documentConcurrency, 1, 1, 1);
    this.pollIntervalMs = bounded(dependencies.pollIntervalMs, 1_000, 250, 10_000);
    this.maintenanceIntervalMs = bounded(dependencies.maintenanceIntervalMs, 60_000, 10_000, 3_600_000);
    this.onTaskError = dependencies.onTaskError ?? (() => undefined);
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  get activeTaskCount(): number {
    return this.active.size;
  }

  requestShutdown(reason = "Worker shutdown requested."): void {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdownController.abort(new Error(reason));
  }

  private launch(kind: "chat" | "document", task: () => Promise<unknown>): void {
    if (this.stopped) return;
    if (kind === "chat") this.runningChats += 1;
    else this.runningDocuments += 1;
    const tracked: Promise<void> = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch((error) => this.onTaskError(kind, error))
      .finally(() => {
        if (kind === "chat") this.runningChats -= 1;
        else this.runningDocuments -= 1;
        this.active.delete(tracked);
      });
    this.active.add(tracked);
  }

  private async claimAvailable(): Promise<boolean> {
    let claimed = false;
    while (!this.stopped && this.runningChats < this.chatConcurrency) {
      const chat = await this.dependencies.claimChat();
      if (!chat) break;
      claimed = true;
      this.launch("chat", () => this.dependencies.executeChat(chat, this.shutdownController.signal));
    }
    while (!this.stopped && this.runningDocuments < this.documentConcurrency) {
      const document = await this.dependencies.claimDocument();
      if (!document) break;
      claimed = true;
      this.launch("document", () => this.dependencies.executeDocument(document, this.shutdownController.signal));
    }
    return claimed;
  }

  private maybeMaintain(): void {
    if (!this.dependencies.maintenance || this.maintenanceRunning || Date.now() - this.lastMaintenanceAt < this.maintenanceIntervalMs) return;
    this.lastMaintenanceAt = Date.now();
    this.maintenanceRunning = true;
    void this.dependencies.maintenance()
      .catch((error) => this.onTaskError("maintenance", error))
      .finally(() => { this.maintenanceRunning = false; });
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      this.maybeMaintain();
      const claimed = await this.claimAvailable().catch((error) => {
        this.onTaskError("maintenance", error);
        return false;
      });
      if (this.stopped) break;
      const active = [...this.active];
      const delay = claimed || active.length ? Math.min(this.pollIntervalMs, 500) : this.pollIntervalMs;
      try {
        await Promise.race([this.sleep(delay, this.shutdownController.signal), ...active]);
      } catch {
        if (!this.stopped) this.onTaskError("maintenance", new Error("Worker polling was interrupted."));
      }
    }
  }

  async shutdown(timeoutMs = 25_000): Promise<void> {
    this.requestShutdown();
    if (!this.active.size) return;
    const tasks = Promise.allSettled([...this.active]);
    await Promise.race([tasks, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }
}
