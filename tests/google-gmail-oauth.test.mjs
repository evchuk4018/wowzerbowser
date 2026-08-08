import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_GMAIL_SCOPE,
  exchangeGoogleGmailCode,
  googleGmailAuthorizationUrl,
  refreshGoogleGmailAccessToken,
} from "../app/server/connectors/providers/google-gmail-oauth.ts";
import { GoogleGmailProvider } from "../app/server/connectors/providers/google-gmail-provider.ts";

function configureGoogleOAuth() {
  const previous = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  };
  process.env.GOOGLE_OAUTH_CLIENT_ID = "gmail-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gmail-client-secret";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  return () => {
    if (previous.clientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.clientSecret;
    if (previous.siteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous.siteUrl;
  };
}

test("Gmail OAuth requests offline read-only access and uses the connector callback", () => {
  const restore = configureGoogleOAuth();
  try {
    const url = new URL(googleGmailAuthorizationUrl("state-value"));
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.pathname, "/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "gmail-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/api/connectors/callback");
    assert.equal(url.searchParams.get("scope"), GOOGLE_GMAIL_SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("state"), "state-value");
  } finally {
    restore();
  }
});

test("Gmail OAuth exchanges authorization codes for access and refresh tokens", async () => {
  const restore = configureGoogleOAuth();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), body: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify(requests.length === 1
      ? { access_token: "exchange-access-token", refresh_token: "refresh-token", scope: GOOGLE_GMAIL_SCOPE }
      : { access_token: "refreshed-access-token" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await exchangeGoogleGmailCode("authorization-code"), {
      accessToken: "exchange-access-token",
      refreshToken: "refresh-token",
      scope: GOOGLE_GMAIL_SCOPE,
    });
    assert.equal(await refreshGoogleGmailAccessToken("refresh-token"), "refreshed-access-token");
    assert.equal(requests[0].input, "https://oauth2.googleapis.com/token");
    assert.equal(requests[0].body.get("grant_type"), "authorization_code");
    assert.equal(requests[0].body.get("redirect_uri"), "https://example.test/api/connectors/callback");
    assert.equal(requests[1].body.get("grant_type"), "refresh_token");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Gmail connection completion profiles with the exchanged access token", async () => {
  const restore = configureGoogleOAuth();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        access_token: "exchange-access-token",
        refresh_token: "refresh-token",
        scope: GOOGLE_GMAIL_SCOPE,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requests.length === 2 && String(input) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return new Response(JSON.stringify({ emailAddress: "owner@example.test" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  try {
    const result = await new GoogleGmailProvider().completeConnection({
      ownerId: "owner-1",
      connectorId: "gmail",
      code: "authorization-code",
      state: "state-value",
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].init?.headers?.authorization, "Bearer exchange-access-token");
    assert.deepEqual(result, {
      accountLabel: "owner@example.test",
      accountEmail: "owner@example.test",
      credentials: { refresh_token: "refresh-token" },
      metadata: { scope: GOOGLE_GMAIL_SCOPE },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
