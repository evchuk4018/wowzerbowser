import { readFile } from "node:fs/promises";

const base = (process.env.MINIFLUX_URL || "http://miniflux:8080").replace(/\/$/u, "");
const token = process.env.MINIFLUX_API_TOKEN?.trim();
if (!token) throw new Error("MINIFLUX_API_TOKEN must be set to provision feeds.");

const feeds = JSON.parse(await readFile(new URL("../config/miniflux-feeds.json", import.meta.url), "utf8"));
if (!Array.isArray(feeds)) throw new Error("The Miniflux feed manifest must be an array.");

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Accept: "application/json", "X-Auth-Token": token, ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Miniflux API request failed with status ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

const existing = await api("/v1/feeds");
const known = new Set((Array.isArray(existing) ? existing : []).map((feed) => feed.feed_url).filter(Boolean));
let created = 0;
for (const feed of feeds) {
  if (!feed || typeof feed.url !== "string" || !feed.url.trim()) continue;
  if (known.has(feed.url)) continue;
  await api("/v1/feeds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feed_url: feed.url }) });
  known.add(feed.url);
  created += 1;
  console.log(`miniflux-feed-created\t${feed.name || feed.url}`);
}
console.log(`miniflux-feed-sync\tmanifest=${feeds.length}\tcreated=${created}\texisting=${known.size - created}`);
