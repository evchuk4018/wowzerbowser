import { readFile } from "node:fs/promises";

export function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function hasArgument(name) {
  return process.argv.includes(name);
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

export async function loadEnvironmentFile() {
  const filePath = argumentValue("--env-file") ?? process.env.DEPLOYMENT_ENV_FILE ?? ".env";
  try {
    const values = parseEnvFile(await readFile(filePath, "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (argumentValue("--env-file")) throw new Error(`Deployment environment file is missing: ${filePath}`);
  }
}

export function configuredOwner() {
  const email = process.env.APP_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("APP_OWNER_EMAIL is required.");
  const ownerId = process.env.APP_OWNER_ID?.trim();
  if (!ownerId) throw new Error("APP_OWNER_ID is required.");
  return { email, ownerId };
}

async function readHiddenPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stdout.write("Owner password: ");
  return new Promise((resolve, reject) => {
    let password = "";
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") {
        cleanup();
        reject(new Error("Password entry cancelled."));
        return;
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(password);
        return;
      }
      if (text === "\u007f") password = password.slice(0, -1);
      else password += text;
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function passwordFromPrivateInput() {
  const envPassword = process.env.APP_OWNER_PASSWORD;
  const password = typeof envPassword === "string" && envPassword.length ? envPassword : await readHiddenPassword();
  if (password.length < 12) throw new Error("Owner passwords must be at least 12 characters.");
  return password;
}

export function validateArguments(allowed) {
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (!value.startsWith("--")) continue;
    if (!allowed.has(value)) throw new Error(`Unknown option: ${value}`);
    if (value === "--env-file" && !process.argv[index + 1]) throw new Error("--env-file requires a path.");
    if (value === "--env-file") index += 1;
  }
}
