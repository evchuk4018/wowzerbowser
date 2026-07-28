import "server-only";

import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";
import type { ExecutableCustomTool } from "./custom-tool-repository";

export function customToolDefinitions(tools: ExecutableCustomTool[]): DeepSeekToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function customToolInstructions(tools: ExecutableCustomTool[]): string[] {
  return tools.filter((tool) => tool.instructions.trim()).map((tool) =>
    `<custom_tool name="${tool.name}">\n${tool.instructions.trim()}\n</custom_tool>`);
}
