import { createHash } from "node:crypto";

export const OPENROUTER_SORTS = [
  "pricing-low-to-high", "pricing-high-to-low", "context-high-to-low",
  "throughput-high-to-low", "latency-low-to-high", "most-popular",
  "top-weekly", "newest", "intelligence-high-to-low",
  "design-arena-elo-high-to-low",
] as const;
export type OpenRouterSort = (typeof OPENROUTER_SORTS)[number];

const listFields = new Set(["supported_parameters", "input_modalities", "output_modalities", "arch", "model_authors", "providers"]);
const scalarFields = new Set(["q", "category", "context", "min_price", "max_price", "distillable", "zdr", "region", "sort", "enabled"]);
export const OPENROUTER_MODEL_QUERY_KEYS = new Set([...listFields, ...scalarFields, "scope"]);
const token = /^[a-zA-Z0-9._:/+-]{1,128}$/;
const booleanValues = new Set(["true", "false"]);

export class CatalogQueryError extends Error {}
export type CatalogQuery = { upstream: URLSearchParams; applied: Record<string, string | string[]>; enabled: "all" | "enabled" };

function cleanToken(value: string, field: string): string {
  const clean = value.trim();
  if (!token.test(clean)) throw new CatalogQueryError(`${field} contains an invalid value.`);
  return clean;
}

export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
  for (const key of params.keys()) if (!OPENROUTER_MODEL_QUERY_KEYS.has(key)) throw new CatalogQueryError(`Unsupported query parameter: ${key}.`);
  const upstream = new URLSearchParams();
  const applied: Record<string, string | string[]> = {};
  for (const field of listFields) {
    const values = params.getAll(field).flatMap((value) => value.split(",")).filter(Boolean).map((value) => cleanToken(value, field));
    if (!values.length) continue;
    const unique = [...new Set(values)].sort();
    applied[field] = unique;
    for (const value of unique) upstream.append(field, value);
  }
  for (const field of scalarFields) {
    const raw = params.get(field);
    if (raw === null || field === "enabled") continue;
    let value = raw.trim();
    if (!value) continue;
    if (field === "q") {
      if (value.length > 200) throw new CatalogQueryError("q is too long.");
    } else if (field === "sort") {
      if (!OPENROUTER_SORTS.includes(value as OpenRouterSort)) throw new CatalogQueryError("sort is invalid.");
      if (value === "top-weekly") value = "most-popular";
    } else if (["context", "min_price", "max_price"].includes(field)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new CatalogQueryError(`${field} must be a non-negative number.`);
      value = String(number);
    } else if (field === "distillable") {
      if (!booleanValues.has(value)) throw new CatalogQueryError(`${field} must be true or false.`);
    } else if (field === "zdr") {
      if (value !== "true") throw new CatalogQueryError("zdr must be true.");
    } else if (field === "region") {
      if (value !== "eu") throw new CatalogQueryError("region must be eu.");
    } else {
      value = cleanToken(value, field);
    }
    applied[field] = value;
    upstream.set(field, value);
  }
  const enabled = params.get("enabled") ?? "all";
  if (enabled !== "all" && enabled !== "enabled") throw new CatalogQueryError("enabled must be all or enabled.");
  // Baseline eligibility is immutable.
  if (!upstream.getAll("output_modalities").includes("text")) upstream.append("output_modalities", "text");
  if (!upstream.getAll("supported_parameters").includes("tools")) upstream.append("supported_parameters", "tools");
  applied.output_modalities = upstream.getAll("output_modalities");
  applied.supported_parameters = upstream.getAll("supported_parameters");
  return { upstream, applied, enabled };
}

export function canonicalCatalogQuery(query: CatalogQuery): string {
  return [...query.upstream.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
export function catalogQueryHash(query: CatalogQuery): string {
  return createHash("sha256").update(canonicalCatalogQuery(query)).digest("hex");
}
