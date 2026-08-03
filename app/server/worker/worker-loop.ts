export type WorkerSchedulerTask = {
  name: string;
  intervalMs: number;
  run: (shutdownSignal: AbortSignal) => Promise<unknown>;
};

type WorkerTaskKind = "chat" | "document" | "image" | "maintenance" | "scheduler";

export type WorkerLoopDependencies<ChatClaim, DocumentClaim, ImageClaim> = {
  claimChat: () => Promise<ChatClaim | null>;
  executeChat: (claim: ChatClaim, shutdownSignal: AbortSignal) => Promise<unknown>;
  claimDocument: () => Promise<DocumentClaim | null>;
  executeDocument: (claim: DocumentClaim, shutdownSignal: AbortSignal) => Promise<unknown>;
  claimImage: () => Promise<ImageClaim | null>;
  executeImage: (claim: ImageClaim, shutdownSignal: AbortSignal) => Promise<unknown>;
  maintenance?: () => Promise<unknown>;
  pollIntervalMs?: number;
  maintenanceIntervalMs?: number;
  chatConcurrency?: number;
  documentConcurrency?: number;
  imageConcurrency?: number;
  schedulerTasks?: WorkerSchedulerTask[];
  onTaskError?: (kind: WorkerTaskKind, error: unknown) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
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

type ScheduledTaskState = WorkerSchedulerTask & {
  nextRunAt: number;
  running: boolean;
};

/**
 * Small single-process supervisor. PostgreSQL owns all durable state; this
 * loop only owns in-memory slots and abort signals for graceful shutdown.
 */
export class BackgroundWorkerLoop<ChatClaim, DocumentClaim, ImageClaim> {
  private readonly shutdownController = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly chatConcurrency: number;
  private readonly documentConcurrency: number;
  private readonly imageConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly onTaskError: (kind: WorkerTaskKind, error: unknown) => void;
  private stopped = false;
  private runningChats = 0;
  private runningDocuments = 0;
  private runningImages = 0;
  private readonly scheduledTasks: ScheduledTaskState[];
  private readonly scheduledActive = new Set<Promise<void>>();

  constructor(private readonly dependencies: WorkerLoopDependencies<ChatClaim, DocumentClaim, ImageClaim>) {
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
    this.chatConcurrency = bounded(dependencies.chatConcurrency, 1, 1, 1);
    this.documentConcurrency = bounded(dependencies.documentConcurrency, 1, 1, 1);
    this.imageConcurrency = bounded(dependencies.imageConcurrency, 1, 1, 1);
    this.pollIntervalMs = bounded(dependencies.pollIntervalMs, 1_000, 250, 10_000);
    this.maintenanceIntervalMs = bounded(dependencies.maintenanceIntervalMs, 60_000, 10_000, 3_600_000);
    this.onTaskError = dependencies.onTaskError ?? (() => undefined);
    this.scheduledTasks = [
      ...(dependencies.maintenance ? [{ name: "maintenance", intervalMs: this.maintenanceIntervalMs, run: async () => dependencies.maintenance?.() }] : []),
      ...(dependencies.schedulerTasks ?? []),
    ].map((task) => ({
      ...task,
      intervalMs: bounded(task.intervalMs, 60_000, 1_000, 3_600_000),
      nextRunAt: this.now(),
      running: false,
    }));
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  get activeTaskCount(): number {
    return this.active.size + this.scheduledActive.size;
  }

  requestShutdown(reason = "Worker shutdown requested."): void {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdownController.abort(new Error(reason));
  }

  private launch(kind: "chat" | "document" | "image", task: () => Promise<unknown>): void {
    if (this.stopped) return;
    if (kind === "chat") this.runningChats += 1;
    else if (kind === "document") this.runningDocuments += 1;
    else this.runningImages += 1;
    const tracked: Promise<void> = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch((error) => this.onTaskError(kind, error))
      .finally(() => {
        if (kind === "chat") this.runningChats -= 1;
        else if (kind === "document") this.runningDocuments -= 1;
        else this.runningImages -= 1;
        this.active.delete(tracked);
      });
    this.active.add(tracked);
  }

  private launchScheduled(task: ScheduledTaskState): void {
    if (this.stopped || task.running) return;
    task.running = true;
    task.nextRunAt = this.now() + task.intervalMs;
    const tracked: Promise<void> = Promise.resolve()
      .then(() => task.run(this.shutdownController.signal))
      .then(() => undefined)
      .catch((error) => this.onTaskError("scheduler", error))
      .finally(() => {
        task.running = false;
        this.scheduledActive.delete(tracked);
      });
    this.scheduledActive.add(tracked);
  }

  private runScheduledTasks(): void {
    const now = this.now();
    for (const task of this.scheduledTasks) {
      if (!task.running && now >= task.nextRunAt) this.launchScheduled(task);
    }
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
    while (!this.stopped && this.runningImages < this.imageConcurrency) {
      const image = await this.dependencies.claimImage();
      if (!image) break;
      claimed = true;
      this.launch("image", () => this.dependencies.executeImage(image, this.shutdownController.signal));
    }
    return claimed;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      this.runScheduledTasks();
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
    if (!this.active.size && !this.scheduledActive.size) return;
    const tasks = Promise.allSettled([...this.active, ...this.scheduledActive]);
    await Promise.race([tasks, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }
}
