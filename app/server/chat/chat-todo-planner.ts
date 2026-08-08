import "server-only";
import { completeOpenRouterQwenText } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { hasActiveTodo, normalizeTodoList, type TodoItem, type TodoList } from "../../../lib/todo-protocol";
import { replaceTodoList } from "./chat-todo-store";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const MAX_SAFE_PROMPT_CHARACTERS = 100_000;
const MAX_SAFE_OUTPUT_TOKENS = 2_000;
const MAX_SAFE_ATTEMPTS = 4;
const SYSTEM = [
  "Create a concise task plan only for substantial work.",
  "Use a plan for a singular complex task or a long, genuinely multi-step task such as deep research, comparing sources, or researching and creating a document.",
  "For ordinary questions, short requests, one-off explanations, brainstorming, casual conversation, or an isolated math/problem-solving question, return no items.",
  "Return only strict JSON: {\"items\":[{\"id\":\"stable-kebab-id\",\"text\":\"objective\",\"status\":\"pending\"}]}. Use at most five items. Preserve completed items when still relevant. Do not include markdown.",
].join(" ");

const MATH_OR_PROBLEM_WORDS = /\b(?:math(?:ematics)?|algebra|geometry|calculus|trigonometry|statistics|equation|integral|derivative|proof|theorem|word problem)\b/i;
const PROBLEM_SOLVING_WORDS = /\b(?:help|solve|work through|answer|calculate|prove|evaluate|explain|question|problem)\b/i;
const RESEARCH_WORDS = /\b(?:research|deep dive|literature review|investigate|sources?|citations?)\b/i;
const RESEARCH_DEPTH_WORDS = /\b(?:deep|thorough|comprehensive|detailed|in-depth|literature|sources?|citations?|compare|historical survey)\b/i;
const DELIVERABLE_WORDS = /\b(?:document|report|guide|presentation|slides?|spreadsheet|proposal|brief|roadmap|spec(?:ification)?|memo|pdf|docx|checklist|research paper)\b/i;
const DELIVERABLE_VERBS = /\b(?:create|write|draft|build|generate|prepare|produce|compile|turn|make)\b/i;
const WORK_VERBS = /\b(?:research|investigate|analy[sz]e|compare|evaluate|design|build|develop|implement|refactor|migrate|audit|organize|compile|synthesize|prepare|generate|create|write|draft|debug|solve)\b/gi;
const COMPLEX_WORK_VERBS = /\b(?:research|investigate|analy[sz]e|compare|evaluate|design|build|develop|implement|refactor|migrate|audit|organize|compile|synthesize|debug|solve)\b/i;
const COMPLEX_SCOPE_WORDS = /\b(?:complete|comprehensive|detailed|thorough|end-to-end|full|entire|complex|production-ready|multiple|several|workflow|pipeline|website|web app|application|system|database|schema|strategy|project|migration)\b/i;
const MULTI_STEP_WORDS = /\b(?:step-by-step|multi-step|multiple steps|multiple stages|workflow|first\b.{0,100}\bthen\b|then\b.{0,100}\b(?:finally|after that|and)\b|after that|from .{1,100} to .{1,100})\b/i;
const TASK_CONTINUATION_WORDS = /\b(?:continue|proceed|next|update|revise|expand|add|remove|change|finish|complete|mark|based on|now)\b/i;

function countWorkVerbs(message: string): number {
  return new Set((message.match(WORK_VERBS) ?? []).map((verb) => verb.toLowerCase())).size;
}

/**
 * Keep the expensive planner out of normal Q&A. This is intentionally a
 * conservative gate: the planner can still decline a borderline request,
 * but it never gets a chance to create a todo for an obviously small one.
 */
export function shouldPlanTodos(userMessage: string, current: TodoList): boolean {
  const message = userMessage.replace(/\s+/g, " ").trim();
  if (!message) return false;

  const isMathProblem = MATH_OR_PROBLEM_WORDS.test(message) && PROBLEM_SOLVING_WORDS.test(message);
  if (isMathProblem) return false;

  const hasResearchRequest = RESEARCH_WORDS.test(message) && (
    RESEARCH_DEPTH_WORDS.test(message) || message.length >= 160 || countWorkVerbs(message) >= 2
  );
  const hasDeliverableRequest = DELIVERABLE_WORDS.test(message) && DELIVERABLE_VERBS.test(message);
  const hasMultiStepRequest = MULTI_STEP_WORDS.test(message) && countWorkVerbs(message) >= 1;
  const hasComplexTask = COMPLEX_WORK_VERBS.test(message) && (
    COMPLEX_SCOPE_WORDS.test(message) || message.length >= 160
  );

  if (hasResearchRequest || hasDeliverableRequest || hasMultiStepRequest || hasComplexTask) return true;

  // A short continuation can legitimately update an existing plan without
  // opening a new one, but a casual follow-up should not invoke the planner.
  return hasActiveTodo(current) && (TASK_CONTINUATION_WORDS.test(message) || message.length >= 160);
}

function parseItems(content: string): TodoItem[] {
  const parsed = JSON.parse(content) as unknown;
  return normalizeTodoList({ items: (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).items : []) }).items;
}

export async function planTodos(input: {
  ownerId: string;
  conversationId: string;
  userMessage: string;
  previousAssistantOutput?: string;
  current: TodoList;
  signal?: AbortSignal;
  onUsage?: (answer: Awaited<ReturnType<typeof completeOpenRouterQwenText>>) => Promise<void>;
}): Promise<{ list: TodoList | null; plannedThisTurn: boolean }> {
  if (!shouldPlanTodos(input.userMessage, input.current)) {
    return { list: hasActiveTodo(input.current) ? input.current : null, plannedThisTurn: false };
  }

  const prompt = [
    "<user-message>", input.userMessage.slice(0, Math.min(runtimeConfigSnapshot().todoPlannerMaxPromptCharacters, MAX_SAFE_PROMPT_CHARACTERS)), "</user-message>",
    "<previous-assistant-output>", (input.previousAssistantOutput ?? "(first turn)").slice(0, Math.min(runtimeConfigSnapshot().todoPlannerMaxPromptCharacters, MAX_SAFE_PROMPT_CHARACTERS)), "</previous-assistant-output>",
    "<current-todos>", JSON.stringify(input.current.items), "</current-todos>",
  ].join("\n");
  const configuration = runtimeConfigSnapshot();
  const maxAttempts = Math.min(configuration.todoPlannerMaxAttempts, MAX_SAFE_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const answer = await completeOpenRouterQwenText(prompt, {
        systemPrompt: SYSTEM,
        signal: input.signal,
        timeoutMs: configuration.todoPlannerTimeoutMs,
        maxTokens: Math.min(configuration.todoPlannerMaxOutputTokens, MAX_SAFE_OUTPUT_TOKENS),
      });
      await input.onUsage?.(answer);
      const list = await replaceTodoList(input.ownerId, input.conversationId, parseItems(answer.content));
      return { list, plannedThisTurn: list.items.length > 0 };
    } catch {
      if (attempt >= maxAttempts - 1 || input.signal?.aborted) return { list: null, plannedThisTurn: false };
    }
  }
  return { list: null, plannedThisTurn: false };
}
