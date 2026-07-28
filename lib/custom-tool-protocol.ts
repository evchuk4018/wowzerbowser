export const CUSTOM_TOOL_LIMITS = {
  name: 64,
  description: 1000,
  instructions: 4000,
  source: 64 * 1024,
  schemaBytes: 32 * 1024,
  secrets: 16,
  secretBytes: 16 * 1024,
  sampleBytes: 32 * 1024,
} as const;

export type JsonSchema = Record<string, unknown>;
export type CustomToolSecretStatus = { name: string; configured: boolean; fingerprint?: string };
export type CustomToolSummary = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  secrets: CustomToolSecretStatus[];
  createdAt: string;
  updatedAt: string;
};
export type CustomToolDefinition = CustomToolSummary & {
  instructions: string;
  inputSchema: JsonSchema;
  pythonSource: string;
};
export type CustomToolMutation = {
  name: string;
  description: string;
  instructions: string;
  inputSchema: JsonSchema;
  pythonSource: string;
  enabled?: boolean;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
};
export type CustomToolTestResult = {
  ok: boolean;
  output?: unknown;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  timedOut?: boolean;
};

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ALLOWED_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "description", "default", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "pattern",
]);

function text(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maximum) throw new Error(`${field} is invalid.`);
  return result;
}

function validateSchemaNode(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 12) {
    throw new Error("Input schema is invalid.");
  }
  const node = value as Record<string, unknown>;
  for (const key of Object.keys(node)) if (!ALLOWED_SCHEMA_KEYS.has(key)) throw new Error(`Unsupported schema keyword: ${key}.`);
  if (node.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(node.type))) {
    throw new Error("Input schema type is invalid.");
  }
  if (node.properties !== undefined) {
    if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) throw new Error("Schema properties are invalid.");
    for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) {
      if (!name || name.length > 100) throw new Error("Schema property name is invalid.");
      validateSchemaNode(child, depth + 1);
    }
  }
  if (node.items !== undefined) validateSchemaNode(node.items, depth + 1);
  if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((item) => typeof item !== "string"))) {
    throw new Error("Schema required list is invalid.");
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length > 100)) throw new Error("Schema enum is invalid.");
}

export function parseCustomToolMutation(value: unknown, partial = false): CustomToolMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool definition is invalid.");
  const body = value as Record<string, unknown>;
  const name = text(body.name, "Tool name", CUSTOM_TOOL_LIMITS.name);
  if (!TOOL_NAME.test(name)) throw new Error("Tool name must be provider-compatible.");
  const description = text(body.description, "Description", CUSTOM_TOOL_LIMITS.description);
  const instructions = text(body.instructions ?? "", "Instructions", CUSTOM_TOOL_LIMITS.instructions, true);
  const pythonSource = text(body.pythonSource, "Python source", CUSTOM_TOOL_LIMITS.source);
  validateSchemaNode(body.inputSchema);
  const inputSchema = body.inputSchema as JsonSchema;
  if (inputSchema.type !== "object" || JSON.stringify(inputSchema).length > CUSTOM_TOOL_LIMITS.schemaBytes) {
    throw new Error("Input schema must be a bounded object schema.");
  }
  const secrets: Record<string, string> = {};
  if (body.secrets !== undefined) {
    if (!body.secrets || typeof body.secrets !== "object" || Array.isArray(body.secrets)) throw new Error("Secrets are invalid.");
    for (const [secretName, secretValue] of Object.entries(body.secrets as Record<string, unknown>)) {
      if (!SECRET_NAME.test(secretName) || typeof secretValue !== "string" || !secretValue || new TextEncoder().encode(secretValue).byteLength > CUSTOM_TOOL_LIMITS.secretBytes) {
        throw new Error("Secret name or value is invalid.");
      }
      secrets[secretName] = secretValue;
    }
  }
  const removeSecrets = body.removeSecrets === undefined ? [] : body.removeSecrets;
  if (!Array.isArray(removeSecrets) || removeSecrets.some((item) => typeof item !== "string" || !SECRET_NAME.test(item))) throw new Error("Removed secrets are invalid.");
  if (Object.keys(secrets).length + removeSecrets.length > CUSTOM_TOOL_LIMITS.secrets) throw new Error("Too many secrets.");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new Error("Enabled must be a boolean.");
  return {
    name, description, instructions, inputSchema, pythonSource,
    enabled: body.enabled ?? (partial ? undefined : false),
    secrets, removeSecrets: [...new Set(removeSecrets)],
  };
}

export function parseCustomToolTestInput(value: unknown): unknown {
  const bytes = JSON.stringify(value).length;
  if (bytes > CUSTOM_TOOL_LIMITS.sampleBytes) throw new Error("Test input is too large.");
  return value;
}

export function validateJsonAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): void {
  const type = schema.type;
  const valid = type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
    : type === "string" ? typeof value === "string"
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "integer" ? typeof value === "number" && Number.isInteger(value)
    : type === "boolean" ? typeof value === "boolean"
    : type === "null" ? value === null : true;
  if (!valid) throw new Error(`${path} must be ${String(type)}.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path} is not an allowed value.`);
  if (type === "object") {
    const object = value as Record<string, unknown>;
    for (const required of (schema.required as string[] | undefined) ?? []) if (!(required in object)) throw new Error(`${path}.${required} is required.`);
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed.`);
    for (const [key, child] of Object.entries(properties)) if (key in object) validateJsonAgainstSchema(object[key], child, `${path}.${key}`);
  }
  if (type === "array" && schema.items) for (let index = 0; index < (value as unknown[]).length; index++) validateJsonAgainstSchema((value as unknown[])[index], schema.items as JsonSchema, `${path}[${index}]`);
}
