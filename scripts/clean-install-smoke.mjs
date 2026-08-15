import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFiles = ["-f", "compose.yaml", "-f", "compose.smoke.yaml"];


function smokeName(prefix) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`.toLowerCase();
}

function normalizeComposePath(value) {
  return value.replaceAll("\\", "/");
}

function command(args, options = {}) {
  const { input, allowFailure = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`Docker command failed: ${args.slice(-3).join(" ")} (exit ${result.code}).`));
      } else {
        resolve(result);
      }
    });
    if (input === undefined || input === null) child.stdin.end();
    else {
      child.stdin.end(input);
    }
  });
}

function composeArgs(environmentFile, projectName, args) {
  return [
    "compose",
    "--project-directory", root,
    "--env-file", environmentFile,
    "--project-name", projectName,
    ...composeFiles,
    ...args,
  ];
}

function compose(environmentFile, projectName, args, options) {
  return command(composeArgs(environmentFile, projectName, args), options);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function tcpReachable(baseUrl) {
  const target = new URL(baseUrl);
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function poll(label, operation, timeoutMs = 120_000, delayMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not observed";
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Smoke check timed out: ${label} (${lastError}).`);
}

class CookieJar {
  #values = new Map();

  absorb(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
    for (const header of values) {
      const separator = header.indexOf("=");
      if (separator < 1) continue;
      const name = header.slice(0, separator);
      const value = header.slice(separator + 1).split(";", 1)[0];
      const expired = /(?:^|;)\s*max-age=0(?:;|$)/iu.test(header) || !value;
      if (expired) this.#values.delete(name);
      else this.#values.set(name, value);
    }
  }

  header() {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  clear() {
    this.#values.clear();
  }
}

async function request(baseUrl, jar, pathname, init = {}, options = {}) {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase()) && !headers.has("origin")) headers.set("origin", baseUrl);
  const controller = init.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000) : null;
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers,
      redirect: options.redirect ?? "follow",
      signal: init.signal ?? controller.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  jar.absorb(response.headers);
  return response;
}

async function jsonRequest(baseUrl, jar, pathname, init = {}, expectedStatus) {
  const response = await request(baseUrl, jar, pathname, init);
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${pathname}, received a non-JSON response.`);
    }
  }
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${pathname} returned an unexpected status.`);
  return { response, value };
}

async function assertReady(baseUrl, jar) {
  const { response, value } = await jsonRequest(baseUrl, jar, "/api/health");
  if (response.status !== 200 || value?.status !== "ok") return false;
  assert.equal(value.checks?.configuration?.status, "ok");
  assert.equal(value.checks?.database?.status, "ok");
  assert.equal(value.checks?.schema?.status, "ok");
  assert.equal(value.checks?.storage?.status, "ok");
  return true;
}

async function login(baseUrl, jar, email, password) {
  const csrf = await jsonRequest(baseUrl, jar, "/api/auth/csrf", {}, 200);
  assert.equal(typeof csrf.value?.csrfToken, "string");
  const body = new URLSearchParams({
    csrfToken: csrf.value.csrfToken,
    email,
    password,
    callbackUrl: `${baseUrl}/chat`,
  });
  const response = await request(baseUrl, jar, "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, { redirect: "manual" });
  assert.ok([200, 302, 303].includes(response.status), "Credentials login did not succeed.");
  const session = await jsonRequest(baseUrl, jar, "/api/auth/session", {}, 200);
  assert.equal(session.value?.user?.email, email);
}

function jsonHeaders() {
  return { "content-type": "application/json", accept: "application/json" };
}

async function submitChat(baseUrl, jar, ownerEmail) {
  const conversationId = "smoke-chat-conversation";
  const jobId = "smoke-chat-job";
  const persistence = {
    turnId: "smoke-chat-turn",
    versionId: "smoke-chat-version",
    userMessageId: "smoke-chat-user",
    assistantMessageId: "smoke-chat-assistant",
    turnIndex: 0,
    versionIndex: 0,
  };
  const payload = {
    systemPrompt: "clean install smoke",
    userPresence: "",
    messages: [{ role: "user", content: "Prove that the local chat worker is alive." }],
    model: { provider: "deepseek", model: "deepseek-v4-flash" },
    thinking: false,
    reasoningEffort: "minimal",
    contextMode: "full",
    conversationId,
    jobId,
    idempotencyKey: "smoke-chat-idempotency",
    persistence,
  };
  const response = await request(baseUrl, jar, "/api/chat", {
    method: "POST",
    headers: { ...jsonHeaders() },
    body: JSON.stringify(payload),
  });
  assert.ok([200, 202].includes(response.status), `Chat submission returned ${response.status}.`);
  await response.body?.cancel();
  const completed = await poll("durable chat completion", async () => {
    const result = await jsonRequest(baseUrl, jar, `/api/chat/jobs/${conversationId}/${jobId}`);
    if (result.response.status !== 200) return false;
    if (["failed", "cancelled"].includes(result.value?.status)) throw new Error(`chat job ${result.value.status}`);
    return result.value?.status === "completed" ? result.value : false;
  });
  assert.equal(completed.finalOutput, "Deterministic clean-install response.");
  const conversation = await jsonRequest(baseUrl, jar, `/api/chat/conversations/${conversationId}`, {}, 200);
  assert.match(JSON.stringify(conversation.value), /Deterministic clean-install response\./u);
  assert.equal(ownerEmail, "owner@example.test");
  return { conversationId, jobId };
}

async function submitDocument(baseUrl, jar, conversationId) {
  const fixturePath = path.join(root, "tests", "fixtures", "documents", "text-layer.pdf");
  const bytes = await readFile(fixturePath);
  const documentId = "smoke-document";
  const upload = await request(baseUrl, jar, "/api/chat/documents/upload", {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.byteLength),
      "x-conversation-id": conversationId,
      "x-document-id": documentId,
      "x-file-name": "text-layer.pdf",
    },
    body: bytes,
  });
  const uploadValue = await upload.json();
  assert.equal(upload.status, 200, "Document upload failed.");
  const finalize = await jsonRequest(baseUrl, jar, "/api/chat/documents/finalize", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      conversationId,
      documentId,
      storageObjectId: uploadValue.storageObjectId,
      filename: "text-layer.pdf",
      contentType: "application/pdf",
      userMessageId: "smoke-document-user",
      jobId: "smoke-document-source-job",
    }),
  });
  assert.ok([200, 202].includes(finalize.response.status), "Document processing was not queued.");
  const processingJobId = finalize.value.processingJobId;
  const completed = await poll("document processing completion", async () => {
    const result = await jsonRequest(baseUrl, jar, `/api/chat/documents/jobs/${conversationId}/${processingJobId}`);
    if (result.response.status !== 200) return false;
    if (["failed", "cancelled"].includes(result.value?.status)) throw new Error(`document job ${result.value.status}`);
    return result.value?.status === "completed" ? result.value : false;
  });
  assert.equal(completed.document?.id, documentId);
  const downloaded = await request(baseUrl, jar, `/api/chat/documents/${documentId}?conversationId=${conversationId}`);
  assert.equal(downloaded.status, 200, "Stored document could not be downloaded.");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes, "Stored document bytes changed.");
}

async function runAutomation(baseUrl, jar, database, ownerId, projectName, environmentFile) {
  const created = await jsonRequest(baseUrl, jar, "/api/automations", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: "Clean install smoke automation",
      kind: "report",
      instructions: "Return the deterministic local smoke report.",
      schedule: { kind: "interval", everyMinutes: 15 },
      timeZone: "Etc/UTC",
    }),
  }, 201);
  const automationId = created.value.automation.id;
  const sql = `update automations set next_run_at=now() where owner_id='${ownerId}'::uuid and id='${automationId}'::uuid`;
  const updated = await compose(environmentFile, projectName, ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", database.user, "-d", database.name, "-c", sql], { allowFailure: true });
  assert.equal(updated.code, 0, "Could not make the smoke automation due.");
  const result = await poll("automation scheduler completion", async () => {
    const listed = await jsonRequest(baseUrl, jar, "/api/automations", {}, 200);
    const item = listed.value.automations.find((candidate) => candidate.id === automationId);
    if (!item || !item.lastOutcome) return false;
    if (item.lastOutcome === "failed") throw new Error(item.lastError || "automation failed");
    return item;
  });
  assert.equal(result.lastOutcome, "notified");
  return automationId;
}

async function createStaleConversation(baseUrl, jar, database, ownerId, projectName, environmentFile) {
  const conversationId = "smoke-stale-maintenance";
  const sql = `insert into chat_conversations(owner_id,conversation_id,title,created_at,updated_at) values ('${ownerId}'::uuid,'${conversationId}','Stale smoke conversation',now()-interval '2 days',now()-interval '2 days') on conflict (owner_id,conversation_id) do update set updated_at=excluded.updated_at`;
  const inserted = await compose(environmentFile, projectName, ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", database.user, "-d", database.name, "-c", sql], { allowFailure: true });
  assert.equal(inserted.code, 0, "Could not create the stale maintenance fixture.");
  await poll("stale conversation maintenance", async () => {
    const listed = await jsonRequest(baseUrl, jar, "/api/chat/conversations", {}, 200);
    return listed.value.conversations.some((candidate) => candidate.id === conversationId) ? false : true;
  }, 90_000);
}

async function verifyContainerIsolation(projectName, environmentFile) {
  const result = await compose(environmentFile, projectName, ["exec", "-T", "web", "sh", "-c", "test ! -e /srv/storage/media && test -d /srv/storage/wowzerbowser/files/objects"], { allowFailure: true });
  assert.equal(result.code, 0, "Application container can see the protected media tree or lacks local object storage.");
}

async function resourceSnapshot(environmentFile, projectName) {
  const containers = await compose(environmentFile, projectName, ["ps", "-q", "postgres", "web", "background-worker", "opendataloader-hybrid", "python-worker"], { allowFailure: true });
  const ids = containers.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!ids.length) return;
  const stats = await command(["stats", "--no-stream", "--format", "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}", ...ids], { allowFailure: true });
  if (stats.code === 0) {
    for (const line of stats.stdout.trim().split(/\r?\n/u).filter(Boolean)) console.log(`clean-install-smoke\tresources\t${line}`);
  }
}

async function smoke() {
  const port = await freePort();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "wowzerbowser-clean-install-"));
  const storagePath = path.join(temporaryDirectory, "storage");
  const environmentFile = path.join(temporaryDirectory, "smoke.env");
  const projectName = smokeName("wowzerbowser-smoke");
  const volumeName = smokeName("wowzerbowser-smoke-pg");
  const modelCacheName = smokeName("wowzerbowser-smoke-odl");
  const networkName = smokeName("wowzerbowser-smoke-net");
  const pythonWorkspaceVolumeName = smokeName("wowzerbowser-smoke-python");
  const pythonExecutionNetworkName = smokeName("wowzerbowser-smoke-python-net");
  const ownerId = randomUUID();
  const ownerEmail = "owner@example.test";
  const ownerPassword = `SmokeOwner-${randomUUID().replaceAll("-", "")}`;
  const database = { name: "wowzerbowser_smoke", user: "wowzerbowser_smoke", password: `SmokeDb-${randomUUID().replaceAll("-", "")}` };
  const authSecret = `SmokeAuth-${randomUUID().replaceAll("-", "")}`;
  const env = [
    `COMPOSE_PROJECT_NAME=${projectName}`,
    `SMOKE_STORAGE_PATH=${normalizeComposePath(storagePath)}`,
    `SMOKE_POSTGRES_VOLUME_NAME=${volumeName}`,
    `SMOKE_OPENDATALOADER_CACHE_VOLUME_NAME=${modelCacheName}`,
    `SMOKE_NETWORK_NAME=${networkName}`,
    `PYTHON_WORKSPACE_VOLUME_NAME=${pythonWorkspaceVolumeName}`,
    `PYTHON_EXECUTION_NETWORK_NAME=${pythonExecutionNetworkName}`,
    `DEPLOYMENT_ENV_FILE=${normalizeComposePath(environmentFile)}`,
    `APP_OWNER_EMAIL=${ownerEmail}`,
    `APP_OWNER_ID=${ownerId}`,
    `AUTH_SECRET=${authSecret}`,
    `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:${port}`,
    `POSTGRES_DB=${database.name}`,
    `POSTGRES_USER=${database.user}`,
    `POSTGRES_PASSWORD=${database.password}`,
    `DATABASE_URL=postgresql://${database.user}:${database.password}@postgres:5432/${database.name}`,
    `PYTHON_WORKER_SECRET=SmokePython-${randomUUID().replaceAll("-", "")}`,
    "APP_UID=1000",
    "APP_GID=1000",
    "WEB_PORT=" + port,
    "USER_MEMORY_DREAMING_ENABLED=false",
    "WORKER_POLL_INTERVAL_MS=250",
    "WORKER_HEARTBEAT_INTERVAL_MS=1000",
    "WORKER_HEARTBEAT_MAX_AGE_MS=30000",
    "STORAGE_MAINTENANCE_INTERVAL_MS=10000",
    "AUTOMATION_SCHEDULER_INTERVAL_MS=10000",
    "MEMORY_SCHEDULER_INTERVAL_MS=10000",
    "DISCORD_ALLOWED_USER_ID=",
    "DEEPSEEK_API_KEY=",
    "OPENROUTER_API_KEY=",
    "OPENCODE_API_KEY=",
    "AUTOMATION_DISPATCH_SECRET=",
  ].join("\n") + "\n";
  const baseUrl = `http://127.0.0.1:${port}`;
  const jar = new CookieJar();
  let stackStarted = false;

  try {
    await writeFile(environmentFile, env, { encoding: "utf8", mode: 0o600 });
    console.log("clean-install-smoke\tcompose-validation");
    const config = await compose(environmentFile, projectName, ["config"], { allowFailure: true });
    assert.equal(config.code, 0, "The disposable Compose configuration is invalid.");
    if (process.env.SMOKE_SKIP_BUILD === "1" || process.argv.includes("--skip-build")) {
      console.log("clean-install-smoke\tclean-build\treused-existing-image");
    } else {
      console.log("clean-install-smoke\tclean-build");
      const build = await compose(environmentFile, projectName, ["build", "--no-cache", "web", "background-worker", "opendataloader-hybrid", "python-worker"], { allowFailure: true });
      assert.equal(build.code, 0, "The clean Docker/npm install failed.");
    }
    console.log("smoke-stage-start-postgres");
    await compose(environmentFile, projectName, ["up", "-d", "postgres", "opendataloader-hybrid", "python-worker"]);
    stackStarted = true;
    console.log("smoke-stage-wait-postgres");
    await poll("PostgreSQL health", async () => (await compose(environmentFile, projectName, ["exec", "-T", "postgres", "pg_isready", "-U", database.user, "-d", database.name], { allowFailure: true })).code === 0, 60_000);
    console.log("smoke-stage-wait-opendataloader");
    await poll("OpenDataLoader hybrid health", async () => (await compose(environmentFile, projectName, ["exec", "-T", "opendataloader-hybrid", "python", "-c", "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:5002/health', timeout=3); raise SystemExit(0 if response.status == 200 else 1)"], { allowFailure: true })).code === 0, 300_000, 1_000);
    await poll("local Python worker health", async () => (await compose(environmentFile, projectName, ["exec", "-T", "python-worker", "python", "-c", "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:5003/health', timeout=3); raise SystemExit(0 if response.status == 200 else 1)"], { allowFailure: true })).code === 0, 60_000, 500);
    console.log("smoke-stage-migrations");
    await compose(environmentFile, projectName, ["run", "--rm", "--no-deps", "-T", "-e", "SKIP_DATABASE_MIGRATION_CHECK=1", "web", "node", "scripts/migrate.mjs", "--initialize"]);
    console.log("smoke-stage-bootstrap");
    await compose(environmentFile, projectName, ["run", "--rm", "--no-deps", "-T", "web", "node", "scripts/bootstrap-owner.mjs", "--password-stdin"], { input: `${ownerPassword}\n` });
    console.log("smoke-stage-start-app");
    await compose(environmentFile, projectName, ["up", "-d", "web", "background-worker"]);
    console.log("smoke-stage-wait-readiness");
    await poll("web TCP port", () => tcpReachable(baseUrl), 60_000, 250);
    await poll("web readiness", () => assertReady(baseUrl, jar), 120_000);
    console.log("clean-install-smoke\towner-login");
    const unauthenticated = await jsonRequest(baseUrl, jar, "/api/chat/conversations");
    assert.equal(unauthenticated.response.status, 401);
    await login(baseUrl, jar, ownerEmail, ownerPassword);
    const { conversationId } = await submitChat(baseUrl, jar, ownerEmail);
    await submitDocument(baseUrl, jar, conversationId);
    console.log("clean-install-smoke\tfile-and-chat-persistence\tok");

    await jsonRequest(baseUrl, jar, "/api/chat/user-preferences", {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ userPresence: "clean-install-owner", visionModel: null, automationModel: { provider: "openrouter", model: "qwen/qwen3.7-flash" }, focusedContextEnabled: true }),
    }, 204);
    const memory = await jsonRequest(baseUrl, jar, "/api/memory", {}, 200);
    assert.ok(Array.isArray(memory.value?.profile?.folders));
    assert.ok(Array.isArray(memory.value?.profile?.memories));
    const automationId = await runAutomation(baseUrl, jar, database, ownerId, projectName, environmentFile);
    await createStaleConversation(baseUrl, jar, database, ownerId, projectName, environmentFile);
    console.log(`clean-install-smoke\tautomation-memory-maintenance\tok\tautomation=${automationId}`);

    await compose(environmentFile, projectName, ["restart", "web", "background-worker"]);
    await poll("web readiness after restart", () => assertReady(baseUrl, jar), 120_000);
    const persistedConversation = await jsonRequest(baseUrl, jar, `/api/chat/conversations/${conversationId}`, {}, 200);
    assert.match(JSON.stringify(persistedConversation.value), /Deterministic clean-install response\./u);
    const persistedPreferences = await jsonRequest(baseUrl, jar, "/api/chat/user-preferences", {}, 200);
    assert.equal(persistedPreferences.value.preferences.userPresence, "clean-install-owner");
    const persistedAutomations = await jsonRequest(baseUrl, jar, "/api/automations", {}, 200);
    assert.ok(persistedAutomations.value.automations.some((item) => item.id === automationId && item.lastOutcome === "notified"));
    await verifyContainerIsolation(projectName, environmentFile);
    await poll("background-worker heartbeat after restart", async () => (await compose(environmentFile, projectName, ["exec", "-T", "background-worker", "node", "scripts/background-worker.mjs", "--health"], { allowFailure: true })).code === 0, 30_000);
    await resourceSnapshot(environmentFile, projectName);
    console.log("clean-install-smoke\trestart-persistence-media-isolation\tok");

    const csrf = await jsonRequest(baseUrl, jar, "/api/auth/csrf", {}, 200);
    const logout = await request(baseUrl, jar, "/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.value.csrfToken, callbackUrl: `${baseUrl}/login` }),
    }, { redirect: "manual" });
    assert.ok([200, 302, 303].includes(logout.status), "Logout did not complete.");
    jar.clear();
    const afterLogout = await jsonRequest(baseUrl, jar, "/api/chat/conversations");
    assert.equal(afterLogout.response.status, 401);
    console.log("clean-install-smoke\tlogout\tok");
  } finally {
    if (stackStarted) await compose(environmentFile, projectName, ["down", "--remove-orphans"], { allowFailure: true });
    if (volumeName.startsWith("wowzerbowser-smoke-")) await command(["volume", "rm", volumeName], { allowFailure: true });
    if (modelCacheName.startsWith("wowzerbowser-smoke-")) await command(["volume", "rm", modelCacheName], { allowFailure: true });
    if (pythonWorkspaceVolumeName.startsWith("wowzerbowser-smoke-")) await command(["volume", "rm", pythonWorkspaceVolumeName], { allowFailure: true });
    if (pythonExecutionNetworkName.startsWith("wowzerbowser-smoke-")) await command(["network", "rm", pythonExecutionNetworkName], { allowFailure: true });
    if (networkName.startsWith("wowzerbowser-smoke-")) await command(["network", "rm", networkName], { allowFailure: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

smoke()
  .then(() => console.log("clean-install-smoke\tpassed"))
  .catch((error) => {
    console.error(`clean-install-smoke\tfailed\t${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
