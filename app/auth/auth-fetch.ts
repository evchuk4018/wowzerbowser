"use client";

/** Same-origin requests carry the HttpOnly Auth.js cookie automatically. */
export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}
