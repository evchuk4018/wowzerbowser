import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withNextServer(callback) {
  const port = 43123;
  const server = spawn(process.execPath, [nextCli, "start", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(`Next server exited before becoming ready:\n${serverOutput}`);
      }
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await delay(100);
      }
    }
    if (!response) {
      throw new Error(`Next server did not become ready:\n${serverOutput}`);
    }
    return await callback(response);
  } finally {
    server.kill();
  }
}

test("server renders the local auth-aware app shell", async () => {
  await withNextServer(async (response) => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(html, /<title>Chat<\/title>/i);
    assert.match(html, /aria-label="Loading session"/);
  });
});

test("keeps Supabase calls behind adapters and owner authorization", async () => {
  const [page, browserAdapter, serverAdapter, ownerService, magicLinkRoute, authService, authForm] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-browser-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-server-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/magic-link/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/magic-link-form.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /@supabase\/supabase-js|createClient\(/);
  assert.match(browserAdapter, /@supabase\/supabase-js/);
  assert.doesNotMatch(browserAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /shouldCreateUser: true/);
  assert.match(ownerService, /APP_OWNER_EMAIL/);
  assert.match(ownerService, /NEXT_PUBLIC_SITE_URL/);
  assert.match(magicLinkRoute, /sendOwnerMagicLink/);
  assert.match(magicLinkRoute, /magic_link_rate_limited/);
  assert.match(authService, /MagicLinkRateLimitError/);
  assert.match(authService, /response\.status === 429/);
  assert.match(browserAdapter, /signInWithPassword/);
  assert.match(browserAdapter, /signUp/);
  assert.match(authForm, /Create password account/);
  assert.match(authForm, /isMagicLinkRateLimitError/);
});

test("keeps DeepSeek access server-side and uses the V4 thinking contract", async () => {
  const [page, client, protocol, adapter, route, modelsRoute, envExample] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/deepseek/deepseek-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/models/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(envExample, /^DEEPSEEK_API_KEY=$/m);
  assert.doesNotMatch(page, /api\.deepseek\.com|DEEPSEEK_API_KEY|@supabase\/supabase-js/);
  assert.doesNotMatch(client, /api\.deepseek\.com|DEEPSEEK_API_KEY|@supabase\/supabase-js/);
  assert.match(protocol, /deepseek-v4-flash/);
  assert.match(protocol, /deepseek-v4-pro/);
  assert.match(protocol, /reasoningEffort/);
  assert.match(protocol, /systemPrompt/);
  assert.match(protocol, /userPresence/);
  assert.match(adapter, /https:\/\/api\.deepseek\.com/);
  assert.match(adapter, /role: "system"/);
  assert.match(adapter, /reasoning_content/);
  assert.match(adapter, /reasoning_effort/);
  assert.match(adapter, /thinking/);
  assert.doesNotMatch(adapter, /deepseek-chat|deepseek-reasoner/);
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /text\/event-stream/);
  assert.match(modelsRoute, /listDeepSeekModels/);
});

test("keeps composer model and thinking controls accessible and responsive", async () => {
  const [page, composer, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(composer, /aria-label="Choose model"/);
  assert.match(composer, /aria-label="Choose thinking mode"/);
  assert.match(composer, /aria-controls="model-options"/);
  assert.match(composer, /aria-controls="thinking-options"/);
  assert.match(composer, /aria-pressed=/);
  assert.match(page, /supportedEfforts/);
  assert.match(page, /Open settings/);
  assert.match(page, /local-chat-settings/);
  assert.match(page, /Always respond in English/);
  assert.match(page, /User presence/);
  assert.match(styles, /backdrop-filter: blur\(8px\)/);
  assert.doesNotMatch(page, /Messages stay on this device/);
  assert.doesNotMatch(styles, /privacy-note/);
  assert.match(styles, /bottom: calc\(100% \+ 8px\)/);
  assert.match(styles, /padding: 34px 0 220px/);
  assert.match(styles, /height: 100dvh;/);
  assert.match(styles, /\.chat-area[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.transcript[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.chat-active \.composer-wrap[\s\S]*?position: absolute;/);
});

test("does not retain removed hosting integrations", async () => {
  const files = [
    "../package.json",
    "../README.md",
    "../.gitignore",
    "../app/globals.css",
  ];
  const contents = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );
  const source = contents.join("\n");
  assert.doesNotMatch(source, /openai|\.openai|sites-vite|cloudflare|vinext|wrangler|D1Database/i);
});
