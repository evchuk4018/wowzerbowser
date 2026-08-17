import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the single-user app derives the owner from environment without passwords or sessions", async () => {
  const previousId = process.env.APP_OWNER_ID;
  const previousEmail = process.env.APP_OWNER_EMAIL;
  process.env.APP_OWNER_ID = "11111111-1111-4111-8111-111111111111";
  process.env.APP_OWNER_EMAIL = "Owner@Example.test";
  try {
    const { configuredOwner, authorizeOwnerSession } = await import("../app/auth/owner-auth-service.ts");
    assert.deepEqual(configuredOwner(), { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" });
    assert.deepEqual(await authorizeOwnerSession(new Request("http://internal:3000/api/chat/conversations")), {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.test",
    });
  } finally {
    if (previousId === undefined) delete process.env.APP_OWNER_ID;
    else process.env.APP_OWNER_ID = previousId;
    if (previousEmail === undefined) delete process.env.APP_OWNER_EMAIL;
    else process.env.APP_OWNER_EMAIL = previousEmail;
  }
});

test("authentication and its UI are fully removed", async () => {
  const [manifest, ownerService, layout] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/layout.tsx", import.meta.url), "utf8"),
  ]);

  const manifestJson = JSON.parse(manifest);
  assert.equal(manifestJson.dependencies["next-auth"], undefined);
  assert.equal(manifestJson.scripts["auth:bootstrap"], undefined);
  assert.equal(manifestJson.scripts["auth:reset-password"], undefined);
  assert.doesNotMatch(ownerService, /next-auth|Credentials|password|signIn|signOut|AUTH_SECRET/i);
  assert.doesNotMatch(ownerService, /sameOriginRequest|hasSessionCookie|AUTH_DEBUG/);
  assert.doesNotMatch(layout, /redirect\(|login/);
});

test("client auth helpers are gone", async () => {
  const denied = await Promise.all([
    "app/auth/auth-service.ts",
    "app/auth/login-form.tsx",
    "app/auth/use-auth-session.ts",
    "app/login/page.tsx",
    "auth.ts",
    "app/api/auth/session/route.ts",
    "app/server/auth/password.mjs",
  ].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8").then(() => true).catch(() => false)));
  assert.deepEqual(denied, denied.map(() => false));
});