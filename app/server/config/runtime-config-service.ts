import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import {
  RUNTIME_CONFIG_DESCRIPTORS,
  type RuntimeConfigDescriptor,
  type RuntimeConfigKey,
  type RuntimeConfigResponse,
  type RuntimeConfigValue,
  type RuntimeConfigValues,
  isRuntimeConfigKey,
} from "../../../lib/runtime-config-protocol";
import { readRuntimeConfigOverrides, saveRuntimeConfigOverrides } from "./runtime-config-repository";
import { writeSearxngSettings } from "./searxng-config";

type RuntimeConfigGlobals = typeof globalThis & {
  runtimeConfigOverrides?: Record<string, unknown>;
  runtimeConfigOwnerId?: string;
  runtimeConfigUpdatedAt?: string | null;
  runtimeConfigLoadedAt?: number;
};

const globals = globalThis as RuntimeConfigGlobals;
const runtimeConfigScope = new AsyncLocalStorage<RuntimeConfigValues>();

export class RuntimeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigValidationError";
  }
}

function booleanFromEnvironment(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  return fallback;
}

function parseEnvironmentValue(descriptor: RuntimeConfigDescriptor, value: string | undefined): RuntimeConfigValue {
  if (value === undefined) return descriptor.defaultValue;
  if (descriptor.type === "boolean") return booleanFromEnvironment(value, descriptor.defaultValue as boolean);
  if (descriptor.type === "list") {
    const values = value.split(",").map((item) => item.trim()).filter(Boolean);
    return values.length ? values : descriptor.defaultValue;
  }
  if (descriptor.type === "integer") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? boundNumber(descriptor, parsed) : descriptor.defaultValue;
  }
  if (descriptor.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? boundNumber(descriptor, parsed) : descriptor.defaultValue;
  }
  return value.trim();
}

function boundNumber(descriptor: RuntimeConfigDescriptor, value: number): number {
  const minimum = descriptor.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = descriptor.maximum ?? Number.POSITIVE_INFINITY;
  return Math.min(maximum, Math.max(minimum, value));
}

function validateText(descriptor: RuntimeConfigDescriptor, value: string): string {
  const trimmed = value.trim();
  if (descriptor.maximum !== undefined && trimmed.length > descriptor.maximum) throw new RuntimeConfigValidationError(`${descriptor.label} must be ${descriptor.maximum} characters or shorter.`);
  if (descriptor.type === "url") {
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new RuntimeConfigValidationError(`${descriptor.label} must be a valid HTTP(S) URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RuntimeConfigValidationError(`${descriptor.label} must be an HTTP(S) URL without credentials.`);
  }
  return trimmed;
}

function normalizeValue(descriptor: RuntimeConfigDescriptor, value: unknown): RuntimeConfigValue {
  if (descriptor.type === "boolean") {
    if (typeof value !== "boolean") throw new RuntimeConfigValidationError(`${descriptor.label} must be true or false.`);
    return value;
  }
  if (descriptor.type === "list") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new RuntimeConfigValidationError(`${descriptor.label} must be a list of strings.`);
    const values = value.map((item) => item.trim()).filter(Boolean);
    if (!values.length || values.some((item) => !["html", "json", "csv", "rss"].includes(item)) || !values.includes("json")) throw new RuntimeConfigValidationError(`${descriptor.label} must contain the JSON format used by the application.`);
    return [...new Set(values)];
  }
  if (descriptor.type === "integer" || descriptor.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (descriptor.type === "integer" && !Number.isSafeInteger(value))) throw new RuntimeConfigValidationError(`${descriptor.label} must be a valid ${descriptor.type}.`);
    if (descriptor.minimum !== undefined && value < descriptor.minimum || descriptor.maximum !== undefined && value > descriptor.maximum) throw new RuntimeConfigValidationError(`${descriptor.label} must be between ${descriptor.minimum} and ${descriptor.maximum}.`);
    return value;
  }
  if (typeof value !== "string") throw new RuntimeConfigValidationError(`${descriptor.label} must be text.`);
  return validateText(descriptor, value);
}

export function normalizeRuntimeConfigValue(key: RuntimeConfigKey, value: unknown): RuntimeConfigValue {
  const descriptor = RUNTIME_CONFIG_DESCRIPTORS.find((item) => item.key === key);
  if (!descriptor) throw new RuntimeConfigValidationError(`Unknown runtime configuration key: ${key}.`);
  return normalizeValue(descriptor, value);
}

export function defaultRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfigValues {
  const result = {} as RuntimeConfigValues;
  for (const descriptor of RUNTIME_CONFIG_DESCRIPTORS) {
    result[descriptor.key] = parseEnvironmentValue(descriptor, descriptor.envName ? env[descriptor.envName] : undefined) as never;
  }
  return result;
}

export function resolveRuntimeConfig(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): RuntimeConfigValues {
  const values = defaultRuntimeConfig(env);
  for (const descriptor of RUNTIME_CONFIG_DESCRIPTORS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, descriptor.key)) continue;
    try { values[descriptor.key] = normalizeValue(descriptor, overrides[descriptor.key]) as never; } catch { /* Ignore invalid persisted values and use the safe fallback. */ }
  }
  return values;
}

export function runtimeConfigSnapshot(): RuntimeConfigValues {
  const scoped = runtimeConfigScope.getStore();
  if (scoped) return scoped;
  return resolveRuntimeConfig(globals.runtimeConfigOverrides ?? {});
}

export function withRuntimeConfigOverrides<T>(
  overrides: Partial<Record<RuntimeConfigKey, unknown>>,
  operation: () => T,
): T {
  const current = runtimeConfigSnapshot();
  return runtimeConfigScope.run(resolveRuntimeConfig({ ...current, ...overrides }), operation);
}

function sanitizedOverrides(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const descriptor of RUNTIME_CONFIG_DESCRIPTORS) {
    if (!Object.prototype.hasOwnProperty.call(values, descriptor.key)) continue;
    result[descriptor.key] = normalizeValue(descriptor, values[descriptor.key]);
  }
  return result;
}

export async function refreshRuntimeConfig(ownerId: string, force = false): Promise<RuntimeConfigValues> {
  if (!force && globals.runtimeConfigOwnerId === ownerId && globals.runtimeConfigOverrides && Date.now() - (globals.runtimeConfigLoadedAt ?? 0) < 5_000) return runtimeConfigSnapshot();
  const persisted = await readRuntimeConfigOverrides(ownerId);
  globals.runtimeConfigOwnerId = ownerId;
  globals.runtimeConfigOverrides = sanitizedOverrides(persisted.values);
  globals.runtimeConfigUpdatedAt = persisted.updatedAt;
  globals.runtimeConfigLoadedAt = Date.now();
  return runtimeConfigSnapshot();
}

export async function ensureRuntimeConfigLoaded(ownerId: string): Promise<RuntimeConfigValues> {
  return refreshRuntimeConfig(ownerId);
}

export async function saveRuntimeConfig(ownerId: string, patch: unknown): Promise<RuntimeConfigResponse> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RuntimeConfigValidationError("Configuration values must be an object.");
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) throw new RuntimeConfigValidationError("At least one configuration value is required.");
  const current = await readRuntimeConfigOverrides(ownerId);
  const next = { ...current.values };
  for (const [key, value] of entries) {
    if (!isRuntimeConfigKey(key)) throw new RuntimeConfigValidationError(`Unknown runtime configuration key: ${key}.`);
    next[key] = normalizeRuntimeConfigValue(key, value);
  }
  const updatedAt = await saveRuntimeConfigOverrides(ownerId, sanitizedOverrides(next));
  globals.runtimeConfigOwnerId = ownerId;
  globals.runtimeConfigOverrides = sanitizedOverrides(next);
  globals.runtimeConfigUpdatedAt = updatedAt;
  globals.runtimeConfigLoadedAt = Date.now();
  const values = runtimeConfigSnapshot();
  if (entries.some(([key]) => ["searxngFormats", "searxngLimiter", "searxngPublicInstance"].includes(key))) await writeSearxngSettings(values);
  return runtimeConfigResponse();
}

export function runtimeConfigResponse(): RuntimeConfigResponse {
  const values = runtimeConfigSnapshot();
  const restartRequiredKeys = RUNTIME_CONFIG_DESCRIPTORS.filter((descriptor) => descriptor.restartRequired && Object.prototype.hasOwnProperty.call(globals.runtimeConfigOverrides ?? {}, descriptor.key)).map(({ key }) => key);
  return {
    values,
    descriptors: RUNTIME_CONFIG_DESCRIPTORS,
    updatedAt: globals.runtimeConfigUpdatedAt ?? null,
    restartRequired: restartRequiredKeys.length > 0,
    restartRequiredKeys,
  };
}
