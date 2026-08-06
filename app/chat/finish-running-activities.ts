import type { AssistantActivity } from "./assistant-activity-types";

export function finishRunningActivities(
  activities: AssistantActivity[] | undefined,
  failRunningTools = false,
  finishedAt = Date.now(),
): AssistantActivity[] | undefined {
  return activities?.map((activity) => {
    if (activity.kind === "subagent" && failRunningTools && (activity.status === "queued" || activity.status === "running")) {
      const durationMs =
        activity.durationMs ??
        (activity.startedAt === undefined
          ? undefined
          : Math.max(0, finishedAt - activity.startedAt));
      return { ...activity, status: "failed", durationMs };
    }

    if (activity.status !== "running") return activity;

    const durationMs =
      activity.durationMs ??
      (activity.startedAt === undefined
        ? undefined
        : Math.max(0, finishedAt - activity.startedAt));

    if (activity.kind === "reasoning") {
      return { ...activity, status: "complete", durationMs };
    }

    if (failRunningTools) {
      return { ...activity, status: "failed", durationMs };
    }

    return activity;
  });
}
