import "server-only";

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfigValues } from "../../../lib/runtime-config-protocol";

const generatedRelativePath = path.join("config", "searxng", "settings.yml");

function generatedPath(): string {
  const root = process.env.APP_STORAGE_ROOT?.trim() || "/srv/storage/wowzerbowser";
  return path.join(root, generatedRelativePath);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function searxngSettingsYaml(values: Pick<RuntimeConfigValues, "searxngFormats" | "searxngLimiter" | "searxngPublicInstance">): string {
  const formats = values.searxngFormats.length ? values.searxngFormats : ["html", "json"];
  return [
    "use_default_settings: true",
    "",
    "search:",
    "  formats:",
    ...formats.map((format) => `    - ${yamlString(format)}`),
    "",
    "server:",
    `  limiter: ${values.searxngLimiter ? "true" : "false"}`,
    `  public_instance: ${values.searxngPublicInstance ? "true" : "false"}`,
    '  secret_key: "change-me-with-SEARXNG_SECRET"',
    "",
  ].join("\n");
}

export async function writeSearxngSettings(values: Pick<RuntimeConfigValues, "searxngFormats" | "searxngLimiter" | "searxngPublicInstance">): Promise<void> {
  const target = generatedPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, searxngSettingsYaml(values), { encoding: "utf8", mode: 0o640 });
  await rename(temporary, target);
}

export function searxngSettingsPath(): string {
  return generatedPath();
}
