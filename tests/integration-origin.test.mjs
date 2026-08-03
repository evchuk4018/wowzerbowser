import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SITE_URL = "https://homelab.tail861ffd.ts.net/ignored-path";
const { integrationCallbackUrl, integrationSiteOrigin } = await import("../app/server/integration-site-url.ts");

test("integration callbacks use the configured private origin and discard path components", () => {
  assert.equal(integrationSiteOrigin(), "https://homelab.tail861ffd.ts.net");
  assert.equal(
    integrationCallbackUrl("/api/integrations/google-calendar/callback"),
    "https://homelab.tail861ffd.ts.net/api/integrations/google-calendar/callback",
  );
  assert.throws(() => integrationCallbackUrl("https://provider.example/callback"), /absolute application paths/);
});

test("integration origin rejects credentials and unsupported schemes", () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    process.env.NEXT_PUBLIC_SITE_URL = "https://user:password@example.test";
    assert.throws(() => integrationSiteOrigin(), /credentials/);
    process.env.NEXT_PUBLIC_SITE_URL = "ftp://example.test";
    assert.throws(() => integrationSiteOrigin(), /HTTP or HTTPS/);
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = original;
  }
});
