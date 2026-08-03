import { access, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseEnvFile(source) {
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[1].startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
  return values;
}

async function main() {
  const unknown = process.argv.slice(2).filter((value, index, values) => value.startsWith("--") && value !== "--env-file" && values[index - 1] !== "--env-file");
  if (unknown.length || (process.argv.includes("--env-file") && !argumentValue("--env-file"))) throw new Error("Usage: node scripts/ensure-app-owner-id.mjs [--env-file path]");
  const envPath = path.resolve(argumentValue("--env-file") ?? process.env.DEPLOYMENT_ENV_FILE ?? ".env");
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Deployment environment file is missing: ${envPath}`);
    throw error;
  }
  const values = parseEnvFile(source);
  const configured = (values.APP_OWNER_ID ?? process.env.APP_OWNER_ID ?? "").trim();
  if (configured) {
    if (!UUID_PATTERN.test(configured)) throw new Error("APP_OWNER_ID must be a valid UUID.");
    console.log("app-owner-id\talready-configured");
    return;
  }
  if (!(values.APP_OWNER_EMAIL ?? process.env.APP_OWNER_EMAIL ?? "").trim()) throw new Error("APP_OWNER_EMAIL is required.");
  const ownerId = randomUUID();
  const line = `APP_OWNER_ID=${ownerId}`;
  const updatedSource = /^\s*APP_OWNER_ID\s*=.*$/mu.test(source)
    ? source.replace(/^\s*APP_OWNER_ID\s*=.*$/mu, line)
    : `${source.replace(/\s*$/u, "")}\n${line}\n`;
  await writeFile(envPath, updatedSource, "utf8");
  await access(envPath);
  console.log("app-owner-id\tgenerated-stable-local-owner");
}

main().catch((error) => {
  console.error(`app-owner-id-failed\t${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
