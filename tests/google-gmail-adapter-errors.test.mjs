import test from "node:test";
import assert from "node:assert/strict";
import {
  gmailProfile,
  GoogleGmailAuthorizationError,
} from "../app/server/connectors/providers/google-gmail-adapter.ts";

async function withFetchResponse(response, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Gmail API 401 responses require reconnecting", async () => {
  await withFetchResponse(new Response(JSON.stringify({
    error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" },
  }), { status: 401, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(
      () => gmailProfile("expired-access-token"),
      (error) => error instanceof GoogleGmailAuthorizationError
        && error.message === "Gmail must be reconnected.",
    );
  });
});

test("Gmail API 403 service-disabled responses expose only safe actionable metadata", async () => {
  await withFetchResponse(new Response(JSON.stringify({
    error: {
      code: 403,
      message: "Gmail API is disabled for project private-project-123; visit https://console.example.test/private-project-123",
      status: "PERMISSION_DENIED",
      errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
      details: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        metadata: {
          consumer: "projects/private-project-123",
          activationUrl: "https://console.example.test/private-project-123",
        },
      }],
    },
  }), { status: 403, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(
      () => gmailProfile("access-token"),
      (error) => {
        assert.equal(error instanceof GoogleGmailAuthorizationError, false);
        assert.equal(error.message, "Gmail API access was denied (SERVICE_DISABLED). Enable the Gmail API (gmail.googleapis.com) for the OAuth project, then reconnect Gmail.");
        assert.doesNotMatch(error.message, /private-project-123|console\.example\.test/);
        return true;
      },
    );
  });
});

test("Gmail API 403 insufficient-scope responses explain the required permission safely", async () => {
  await withFetchResponse(new Response(JSON.stringify({
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes for credential secret-credential-value",
      status: "PERMISSION_DENIED",
      errors: [{ reason: "insufficientPermissions", domain: "global" }],
      details: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        metadata: { service: "gmail.googleapis.com", method: "gmail.users.getProfile" },
      }],
    },
  }), { status: 403, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(
      () => gmailProfile("access-token"),
      (error) => {
        assert.equal(error instanceof GoogleGmailAuthorizationError, false);
        assert.equal(error.message, "Gmail API access was denied (ACCESS_TOKEN_SCOPE_INSUFFICIENT). Reconnect Gmail and approve the Gmail read-only permission.");
        assert.doesNotMatch(error.message, /secret-credential-value|gmail\.users\.getProfile/);
        return true;
      },
    );
  });
});
