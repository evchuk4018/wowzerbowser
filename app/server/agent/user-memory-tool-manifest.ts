import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const BROWSE_USER_MEMORY_TOOL = "browse_user_memory";
export const READ_USER_MEMORY_TOOL = "read_user_memory";
export const CREATE_MEMORY_FOLDER_TOOL = "create_memory_folder";
export const ADD_USER_MEMORY_TOOL = "add_user_memory";
export const EDIT_USER_MEMORY_TOOL = "edit_user_memory";
export const MOVE_USER_MEMORY_TOOL = "move_user_memory";
export const DELETE_USER_MEMORY_TOOL = "delete_user_memory";

const path = {
  type: "array",
  minItems: 1,
  maxItems: 9,
  items: { type: "string", minLength: 1, maxLength: 80 },
} as const;

export const USER_MEMORY_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  {
    type: "function",
    function: {
      name: BROWSE_USER_MEMORY_TOOL,
      description: "List the folders and memories at a path in the user's durable User Profile tree. Omit path to list the root.",
      parameters: { type: "object", additionalProperties: false, properties: { path } },
    },
  },
  {
    type: "function",
    function: {
      name: READ_USER_MEMORY_TOOL,
      description: "Read one durable user memory, including its folder path and provenance.",
      parameters: {
        type: "object", additionalProperties: false, required: ["memoryId"],
        properties: { memoryId: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: CREATE_MEMORY_FOLDER_TOOL,
      description: "Create a folder path in the user's durable User Profile.",
      parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path } },
    },
  },
  {
    type: "function",
    function: {
      name: ADD_USER_MEMORY_TOOL,
      description: "Add one explicitly supported, durable fact to the user's profile. Browse first to avoid duplicates. Set sensitive=true for passwords, tokens, API keys, or other security-sensitive values; those are stored as keyed one-way hashes.",
      parameters: {
        type: "object", additionalProperties: false, required: ["path", "content"],
        properties: { path, content: { type: "string", minLength: 1, maxLength: 2_000 }, sensitive: { type: "boolean", description: "Store only a keyed one-way hash of this value." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: EDIT_USER_MEMORY_TOOL,
      description: "Replace an existing memory with newer explicitly supported information. Preserve sensitive=true for security-sensitive values.",
      parameters: {
        type: "object", additionalProperties: false, required: ["memoryId", "content"],
        properties: {
          memoryId: { type: "string", minLength: 1, maxLength: 100 },
          content: { type: "string", minLength: 1, maxLength: 2_000 },
          sensitive: { type: "boolean", description: "Store only a keyed one-way hash of this value." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: MOVE_USER_MEMORY_TOOL,
      description: "Move an existing memory to another profile folder, creating the path when necessary.",
      parameters: {
        type: "object", additionalProperties: false, required: ["memoryId", "path"],
        properties: { memoryId: { type: "string", minLength: 1, maxLength: 100 }, path },
      },
    },
  },
  {
    type: "function",
    function: {
      name: DELETE_USER_MEMORY_TOOL,
      description: "Delete an obsolete or unsupported memory. The deletion remains in the private audit history.",
      parameters: {
        type: "object", additionalProperties: false, required: ["memoryId"],
        properties: { memoryId: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  },
];
