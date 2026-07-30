import type { AutomationRunResult } from "../agent/automation-run-result-tool";

export type AutomationAnswer = {
  matched: boolean;
  title: string;
  message: string;
};

function validateStructuredAnswer(value: unknown): AutomationAnswer {
  if (!value || typeof value !== "object") {
    throw new Error("Automation returned an invalid structured result.");
  }
  const answer = value as Record<string, unknown>;
  if (
    typeof answer.matched !== "boolean"
    || typeof answer.title !== "string"
    || !answer.title.trim()
    || typeof answer.message !== "string"
  ) {
    throw new Error("Automation returned an invalid structured result.");
  }
  return {
    matched: answer.matched,
    title: answer.title.trim().slice(0, 160),
    message: answer.message.trim().slice(0, 50_000),
  };
}

export function resolveAutomationAnswer(
  structuredAnswer: AutomationRunResult | null,
  content: string,
  automationName: string,
): AutomationAnswer {
  if (structuredAnswer) return validateStructuredAnswer(structuredAnswer);

  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!unfenced) {
    throw new Error("Automation returned no usable result.");
  }

  try {
    return validateStructuredAnswer(JSON.parse(unfenced));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  return {
    matched: false,
    title: automationName.trim().slice(0, 160),
    message: unfenced.slice(0, 50_000),
  };
}
