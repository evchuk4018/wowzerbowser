import assert from "node:assert/strict";
import test from "node:test";

const { sameOriginRequest } = await import("../app/auth/owner-auth-service.ts");

test("same-origin auth accepts the configured private origin and rejects mismatches", () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://homelab.tail861ffd.ts.net";
  try {
    assert.equal(
      sameOriginRequest(new Request("https://internal:3000/api/chat/conversations/abc", {
        method: "DELETE",
        headers: { origin: "https://homelab.tail861ffd.ts.net" },
      })),
      true,
    );
    assert.equal(
      sameOriginRequest(new Request("https://internal:3000/api/chat/conversations/abc", {
        method: "DELETE",
        headers: { origin: "https://wowzerbowser.vercel.app" },
      })),
      false,
    );
    assert.equal(
      sameOriginRequest(new Request("https://internal:3000/api/chat/conversations/abc", {
        method: "DELETE",
      })),
      false,
    );
    assert.equal(sameOriginRequest(new Request("https://internal:3000/api/chat/conversations", { method: "GET" })), true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
});
