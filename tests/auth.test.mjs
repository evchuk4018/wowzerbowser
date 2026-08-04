import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hashPassword, verifyPassword } from "../app/server/auth/password.mjs";

test("owner passwords use salted scrypt and reject wrong or altered values", async () => {
  const password = "correct horse battery staple";
  const encoded = await hashPassword(password);
  const secondEncoded = await hashPassword(password);

  assert.match(encoded, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/u);
  assert.notEqual(encoded, secondEncoded);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
  const altered = encoded.split("$");
  altered[5] = Buffer.alloc(64, 1).toString("base64url");
  assert.equal(await verifyPassword(password, altered.join("$")), false);
  assert.equal(await verifyPassword(password, "not-a-password-hash"), false);
});

test("Auth.js is the only browser authentication path and storage is local", async () => {
  const [auth, client, login, storage, storageRuntime, owner, bootstrap, reset] = await Promise.all([
    readFile(new URL("../auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/login-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/server/storage/local-filesystem-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-filesystem-storage.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bootstrap-owner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/reset-owner-password.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /Credentials\(/);
  assert.match(auth, /strategy: "jwt"/);
  assert.match(auth, /trustHost: true/);
  assert.match(auth, /sessionVersion/);
  assert.match(auth, /sameSite: "lax"/);
  assert.match(auth, /httpOnly: true/);
  assert.match(auth, /safeRedirect/);
  assert.match(auth, /advanceOwnerSessionVersion/);
  assert.match(client, /authSignIn\("credentials"/);
  assert.doesNotMatch(client, /@supabase|signInWithOtp|signUp|magic/i);
  assert.match(login, /type="password"/);
  assert.doesNotMatch(login, /Create account|magic link|signUp/i);
  assert.match(storage + "\n" + storageRuntime, /atomic|rename/);
  assert.match(storageRuntime, /O_NOFOLLOW/);
  assert.doesNotMatch(storage + "\n" + storageRuntime, /supabase|storage\.from|signed.?url/i);
  assert.match(owner, /sameOriginRequest/);
  assert.match(owner, /authorizeOwnerSession/);
  assert.match(owner, /AUTH_DEBUG/);
  assert.match(owner, /hasSessionCookie/);
  assert.match(bootstrap, /bootstrapOwner/);
  assert.match(reset, /resetOwnerPassword/);
  assert.doesNotMatch(`${bootstrap}\n${reset}`, /console\.(log|error)\([^)]*(?:passwordHash|APP_OWNER_PASSWORD|passwordFromPrivateInput)/i);
});

test("client auth requests use cookies and strip stale bearer headers", async () => {
  const source = await readFile(new URL("../app/auth/auth-fetch.ts", import.meta.url), "utf8");
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /headers\.delete\("authorization"\)/);
  assert.doesNotMatch(source, /Bearer/);
});
