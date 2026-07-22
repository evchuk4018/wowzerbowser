import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost:3000/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server renders the local auth-aware app shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Chat<\/title>/i);
  assert.match(html, /aria-label="Loading session"/);
});

test("keeps Supabase calls behind adapters and owner authorization", async () => {
  const [page, browserAdapter, serverAdapter, ownerService, magicLinkRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-browser-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-server-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/magic-link/route.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /@supabase\/supabase-js|createClient\(/);
  assert.match(browserAdapter, /@supabase\/supabase-js/);
  assert.doesNotMatch(browserAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /shouldCreateUser: true/);
  assert.match(ownerService, /APP_OWNER_EMAIL/);
  assert.match(ownerService, /NEXT_PUBLIC_SITE_URL/);
  assert.match(magicLinkRoute, /sendOwnerMagicLink/);
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
  assert.match(adapter, /https:\/\/api\.deepseek\.com/);
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
  assert.doesNotMatch(page, /Messages stay on this device/);
  assert.doesNotMatch(styles, /privacy-note/);
  assert.match(styles, /bottom: calc\(100% \+ 8px\)/);
  assert.match(styles, /padding: 34px 0 220px/);
  assert.match(styles, /width: min\(860px, calc\(100vw - 300px - 42px\)\)/);
});
