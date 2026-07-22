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
