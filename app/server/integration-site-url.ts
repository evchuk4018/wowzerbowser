import "server-only";

const LOCAL_SITE_URL = "http://localhost:3000";

/**
 * Return the configured application origin for provider callbacks.
 *
 * The callback origin is deliberately derived on the server. Provider
 * adapters may remain external, but they must never invent a hosted origin
 * when this installation is running behind the private Tailscale URL.
 */
export function integrationSiteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || LOCAL_SITE_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_URL must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("NEXT_PUBLIC_SITE_URL must not contain credentials.");
  }
  return url.origin;
}

export function integrationCallbackUrl(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("Integration callback paths must be absolute application paths.");
  }
  return new URL(pathname, `${integrationSiteOrigin()}/`).toString();
}
