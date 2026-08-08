import "server-only";

import { integrationCallbackUrl } from "../../integration-site-url";

export const MICROSOFT_OUTLOOK_SCOPES = "openid profile email offline_access User.Read Mail.Read";

function required(name: "MICROSOFT_OAUTH_CLIENT_ID" | "MICROSOFT_OAUTH_CLIENT_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function tenant(): string {
  return process.env.MICROSOFT_OAUTH_TENANT?.trim() || "common";
}

export function microsoftOutlookRedirectUri(): string {
  return integrationCallbackUrl("/api/connectors/callback");
}

export function microsoftOutlookAuthorizationUrl(state: string): string {
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: required("MICROSOFT_OAUTH_CLIENT_ID"),
    redirect_uri: microsoftOutlookRedirectUri(),
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_OUTLOOK_SCOPES,
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error_description === "string" ? value.error_description : "Microsoft authorization failed.");
  return value;
}

export async function exchangeMicrosoftOutlookCode(code: string): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const value = await tokenRequest(new URLSearchParams({
    code,
    client_id: required("MICROSOFT_OAUTH_CLIENT_ID"),
    client_secret: required("MICROSOFT_OAUTH_CLIENT_SECRET"),
    redirect_uri: microsoftOutlookRedirectUri(),
    grant_type: "authorization_code",
  }));
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Microsoft did not return an access token.");
  if (typeof value.refresh_token !== "string" || !value.refresh_token) throw new Error("Microsoft did not return offline access. Reconnect and approve Outlook access.");
  return { accessToken: value.access_token, refreshToken: value.refresh_token, scope: typeof value.scope === "string" ? value.scope : MICROSOFT_OUTLOOK_SCOPES };
}

export async function refreshMicrosoftOutlookAccessToken(refreshToken: string): Promise<string> {
  const value = await tokenRequest(new URLSearchParams({
    refresh_token: refreshToken,
    client_id: required("MICROSOFT_OAUTH_CLIENT_ID"),
    client_secret: required("MICROSOFT_OAUTH_CLIENT_SECRET"),
    grant_type: "refresh_token",
  }));
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Outlook must be reconnected.");
  return value.access_token;
}
