import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";

type Schema = Record<string, unknown>;

function record(value: unknown): Schema | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Schema : null;
}

function scalarType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  const input = record(value);
  if (!input) return value;

  const alternatives = Array.isArray(input.anyOf)
    ? input.anyOf
    : Array.isArray(input.oneOf) ? input.oneOf : undefined;
  const result: Schema = {};

  if (typeof input.description === "string") result.description = input.description;
  if (input.nullable === true) result.nullable = true;

  if (alternatives) {
    result.anyOf = alternatives.map(normalizeSchema);
  } else if (Array.isArray(input.type)) {
    const types = input.type.filter((item): item is string => typeof item === "string");
    const nonNullTypes = types.filter((item) => item !== "null");
    if (types.includes("null")) result.nullable = true;
    if (nonNullTypes.length === 1) result.type = nonNullTypes[0];
    else if (nonNullTypes.length > 1) result.anyOf = nonNullTypes.map((type) => ({ type }));
  } else if (typeof input.type === "string") {
    result.type = input.type;
  }

  if (Object.prototype.hasOwnProperty.call(input, "const")) {
    const type = scalarType(input.const);
    if (type && type !== "null") {
      result.type = type;
      result.enum = [input.const];
    } else if (type === "null") {
      result.nullable = true;
    }
  } else if (Array.isArray(input.enum)) {
    result.enum = input.enum;
  }

  const properties = record(input.properties);
  if (properties) {
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [key, normalizeSchema(child)]),
    );
  }
  if (input.items !== undefined) result.items = normalizeSchema(input.items);
  if (Array.isArray(input.required)) result.required = input.required.filter((item): item is string => typeof item === "string");
  if (typeof input.format === "string" && ["date-time", "enum"].includes(input.format)) result.format = input.format;
  if (typeof input.$ref === "string") result.$ref = input.$ref;
  if (record(input.$defs)) result.$defs = normalizeSchema(input.$defs);

  return result;
}

export function gemmaCompatibleToolDefinitions(tools: readonly ModelToolDefinition[]): ModelToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: normalizeSchema(tool.function.parameters) as Record<string, unknown>,
    },
  }));
}

export function isGemmaModel(model: string): boolean {
  return /(?:^|[/:_-])gemma(?:[/:_-]|$)/i.test(model);
}
