import type {
  ChatToolCall,
  ChatToolResult,
} from "../../lib/chat-protocol";

export type ReasoningActivity = {
  id: string;
  kind: "reasoning";
  round: number;
  content: string;
  status: "running" | "complete";
  startedAt?: number;
  durationMs?: number;
};

export type PythonActivity = {
  id: string;
  kind: "python";
  round: number;
  call: ChatToolCall;
  result?: ChatToolResult;
  status: "running" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
};

export type AssistantActivity = ReasoningActivity | PythonActivity;
