import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function configuredValue(values, name) {
  return (values[name] ?? "").trim() || (process.env[name] ?? "").trim();
}

async function readDeploymentEnv(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    return { source, values: parseEnvFile(source) };
  } catch (error) {
    if (error?.code === "ENOENT") return { source: null, values: {} };
    throw error;
  }
}

async function findAuthUserId(baseUrl, secretKey, email) {
  const expectedEmail = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("/auth/v1/admin/users", `${baseUrl.replace(/\/+$/u, "")}/`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "1000");
    const response = await fetch(url, {
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
        accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`Supabase Auth admin lookup failed with HTTP ${response.status}.`);
    const body = await response.json();
    const users = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
    const match = users.find((user) => typeof user?.email === "string" && user.email.trim().toLowerCase() === expectedEmail);
    if (match) {
      if (typeof match.id !== "string" || !UUID_PATTERN.test(match.id)) throw new Error("The matching Supabase Auth user has an invalid ID.");
      return match.id;
    }
    if (users.length < 1000) break;
  }
  throw new Error("APP_OWNER_EMAIL was not found in Supabase Auth; set APP_OWNER_ID to the matching Auth user UUID and retry.");
}

async function main() {
  const unknownArguments = process.argv.slice(2).filter((value, index, values) => value.startsWith("--") && value !== "--env-file" && values[index - 1] !== "--env-file");
  if (unknownArguments.length || (process.argv.includes("--env-file") && !argumentValue("--env-file"))) {
    throw new Error("Usage: node scripts/ensure-app-owner-id.mjs [--env-file path]");
  }

  const requestedPath = argumentValue("--env-file") ?? process.env.DEPLOYMENT_ENV_FILE ?? ".env";
  const envPath = path.resolve(requestedPath);
  const deploymentEnv = await readDeploymentEnv(envPath);
  const configured = configuredValue(deploymentEnv.values, "APP_OWNER_ID");
  if (configured) {
    if (!UUID_PATTERN.test(configured)) throw new Error("APP_OWNER_ID must be a valid UUID.");
    if (!deploymentEnv.source) throw new Error("APP_OWNER_ID is set in the process environment, but the deployment environment file does not exist.");
    console.log("app-owner-id\talready-configured");
    return;
  }

  if (!deploymentEnv.source) throw new Error(`Deployment environment file is missing: ${envPath}`);
  const supabaseUrl = configuredValue(deploymentEnv.values, "SUPABASE_URL");
  const secretKey = configuredValue(deploymentEnv.values, "SUPABASE_SECRET_KEY") || configuredValue(deploymentEnv.values, "SUPABASE_SERVICE_ROLE_KEY");
  const ownerEmail = configuredValue(deploymentEnv.values, "APP_OWNER_EMAIL");
  if (!supabaseUrl || !secretKey || !ownerEmail) throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY, and APP_OWNER_EMAIL are required to resolve APP_OWNER_ID.");

  const ownerId = await findAuthUserId(supabaseUrl, secretKey, ownerEmail);
  const line = `APP_OWNER_ID=${ownerId}`;
  const updatedSource = /^\s*APP_OWNER_ID\s*=.*$/mu.test(deploymentEnv.source)
    ? deploymentEnv.source.replace(/^\s*APP_OWNER_ID\s*=.*$/mu, line)
    : `${deploymentEnv.source.replace(/\s*$/u, "")}\n${line}\n`;
  await writeFile(envPath, updatedSource, "utf8");
  await access(envPath);
  console.log("app-owner-id\tconfigured-from-supabase-auth");
}

main().catch((error) => {
  console.error(`app-owner-id-failed\t${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
