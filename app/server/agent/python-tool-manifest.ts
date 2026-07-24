import { PYTHON_TOOL_INPUT_LIMITS } from "../../../lib/python-tool-policy";

export const PYTHON_TOOL_NAME = "run_python";

export const PYTHON_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: PYTHON_TOOL_NAME,
    description:
      "Run a bounded Python program in the conversation sandbox. Provide exactly one of code or an existing relative file path. Use artifacts to return files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          description: "Non-empty inline Python source, up to 64 KiB.",
        },
        file: {
          type: "string",
          description: "Existing safe relative path in this conversation's volume.",
        },
        packages: {
          type: "array",
          items: { type: "string" },
          maxItems: PYTHON_TOOL_INPUT_LIMITS.maxPackages,
          description: "Validated Python package specifiers to install in the persistent environment.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          maxItems: PYTHON_TOOL_INPUT_LIMITS.maxArgs,
          description: "Command-line arguments, each up to 4096 characters.",
        },
        stdin: {
          type: "string",
          description: "Standard input for the program, up to 64 KiB.",
        },
        artifacts: {
          type: "array",
          items: { type: "string" },
          maxItems: PYTHON_TOOL_INPUT_LIMITS.maxArtifacts,
          description: "Safe relative paths of workspace files to return to the user.",
        },
      },
    },
  },
} as const;
