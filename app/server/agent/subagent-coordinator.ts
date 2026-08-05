import "server-only";

export type SubagentTask = { id: string; title: string; prompt: string };
export type SubagentResult<T> = { task: SubagentTask; value?: T; error?: string };

export async function runSubagents<T>(input: {
  tasks: readonly SubagentTask[];
  signal?: AbortSignal;
  concurrency?: number;
  onUpdate?: (update: { task: SubagentTask; status: "queued" | "running" | "completed" | "failed"; summary?: string }) => Promise<void> | void;
  worker: (task: SubagentTask, signal: AbortSignal) => Promise<T>;
}): Promise<SubagentResult<T>[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const results: SubagentResult<T>[] = [];
  let cursor = 0;
  const limit = Math.max(1, Math.min(input.concurrency ?? 3, input.tasks.length || 1));
  const worker = async () => {
    while (!controller.signal.aborted) {
      const task = input.tasks[cursor++];
      if (!task) return;
      await input.onUpdate?.({ task, status: "running" });
      try {
        const value = await input.worker(task, controller.signal);
        results.push({ task, value });
        await input.onUpdate?.({ task, status: "completed", summary: "Research complete." });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Subagent failed.";
        results.push({ task, error: message });
        await input.onUpdate?.({ task, status: "failed", summary: message });
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  input.signal?.removeEventListener("abort", abort);
  return results.sort((left, right) => input.tasks.indexOf(left.task) - input.tasks.indexOf(right.task));
}
