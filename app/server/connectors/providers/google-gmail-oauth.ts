import "server-only";

import { integrationCallbackUrl } from "../../integration-site-url";

export const GOOGLE_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function required(name: "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function googleGmailRedirectUri(): string {
  return integrationCallbackUrl("/api/connectors/callback");
}

export function googleGmailAuthorizationUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: googleGmailRedirectUri(),
    response_type: "code",
    scope: GOOGLE_GMAIL_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error_description === "string" ? value.error_description : "Google authorization failed.");
  return value;
}

export async function exchangeGoogleGmailCode(code: string): Promise<{ refreshToken: string; scope: string }> {
  const value = await tokenRequest(new URLSearchParams({
    code,
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: googleGmailRedirectUri(),
    grant_type: "authorization_code",
  }));
  if (typeof value.refresh_token !== "string" || !value.refresh_token) throw new Error("Google did not return offline access. Reconnect and approve Gmail access.");
  return { refreshToken: value.refresh_token, scope: typeof value.scope === "string" ? value.scope : GOOGLE_GMAIL_SCOPE };
}

export async function refreshGoogleGmailAccessToken(refreshToken: string): Promise<string> {
  const value = await tokenRequest(new URLSearchParams({
    refresh_token: refreshToken,
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
    grant_type: "refresh_token",
  }));
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Gmail must be reconnected.");
  return value.access_token;
}
