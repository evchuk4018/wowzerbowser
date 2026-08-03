"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../auth/auth-fetch";
import { DEFAULT_CHAT_MODELS, chatModelIdentity, type ChatModelInfo } from "../../lib/chat-protocol";

type CatalogModel = ChatModelInfo & { enabled: boolean };
type CatalogResponse = {
  models: CatalogModel[]; total: number; appliedFilters: Record<string, string | string[]>;
  facets: { authors: string[]; architectures: string[]; providers: Array<{ id: string; name: string }> };
  cache: { stale: boolean; fetchedAt: string }; providerError: string | null;
};
const effortLabels: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const OPENROUTER_SORTS = ["pricing-low-to-high","pricing-high-to-low","context-high-to-low","throughput-high-to-low","latency-low-to-high","most-popular","top-weekly","newest","intelligence-high-to-low","design-arena-elo-high-to-low"];
const sorts = [
  ["most-popular", "Most popular"], ["newest", "Newest"], ["pricing-low-to-high", "Price: low to high"], ["pricing-high-to-low", "Price: high to low"],
  ["context-high-to-low", "Largest context"], ["throughput-high-to-low", "Fastest throughput"],
  ["latency-low-to-high", "Lowest latency"], ["intelligence-high-to-low", "Intelligence"], ["design-arena-elo-high-to-low", "Design Arena ELO"],
] as const;
const money = (value: number | null) => value === null ? "—" : value === 0 ? "Free" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
const context = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;

export function ModelsSettings({ hasSession }: { hasSession: () => Promise<boolean> }) {
  const [filters, setFilters] = useState<Record<string, string>>({ sort: "most-popular", enabled: "all" });
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [advanced, setAdvanced] = useState(false);
  const requestNumber = useRef(0);
  useEffect(() => {
    const number = ++requestNumber.current; const controller = new AbortController(); const timer = setTimeout(() => {
      const params = new URLSearchParams({ scope: "catalog" });
      Object.entries(filters).forEach(([key, value]) => { if (value) value.split(",").forEach((item) => params.append(key, item)); });
      setLoading(true);
      void hasSession().then(() => authFetch(`/api/chat/models?${params}`, { signal: controller.signal }))
        .then(async (response) => { if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Catalog unavailable."); return response.json() as Promise<CatalogResponse>; })
        .then((next) => { if (requestNumber.current === number) { setCatalog(next); setError(null); } })
        .catch((reason) => { if (!controller.signal.aborted && requestNumber.current === number) setError(reason instanceof Error ? reason.message : "Catalog unavailable."); })
        .finally(() => { if (requestNumber.current === number) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filters, hasSession]);
  const update = (key: string, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const chips = useMemo(() => Object.entries(filters).filter(([key, value]) => value && !["sort", "enabled"].includes(key)), [filters]);
  const toggle = async (model: CatalogModel) => {
    const enabled = !model.enabled;
    setCatalog((current) => current ? { ...current, models: current.models.map((item) => chatModelIdentity(item.ref) === chatModelIdentity(model.ref) ? { ...item, enabled } : item) } : current);
    try {
      await hasSession(); const response = await authFetch("/api/chat/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...model.ref, enabled }) });
      if (!response.ok) throw new Error("Could not save model.");
      window.dispatchEvent(new CustomEvent("chat-models-changed"));
    } catch (reason) {
      setCatalog((current) => current ? { ...current, models: current.models.map((item) => chatModelIdentity(item.ref) === chatModelIdentity(model.ref) ? { ...item, enabled: !enabled } : item) } : current);
      setError(reason instanceof Error ? reason.message : "Could not save model.");
    }
  };
  return <div className="models-settings">
    <div className="settings-panel-heading"><h3>Models</h3><p>Choose built-in DeepSeek models and discover eligible OpenRouter chat models.</p></div>
    <h4>Built in</h4><div className="model-card-grid">{DEFAULT_CHAT_MODELS.map((model) => <article className="model-card" key={chatModelIdentity(model.ref)}><strong>{model.displayName}</strong><code>{model.ref.model}</code><p>{context(model.contextLength)} context · Text · Tools</p><span>Reasoning: High, Max</span><b>Always enabled</b></article>)}</div>
    <div className="model-catalog-heading"><h4>OpenRouter discovery</h4><span>{catalog?.total ?? 0} results</span></div>
    <div className="model-toolbar">
      <input aria-label="Search models" placeholder="Search name, slug, or author" value={filters.q ?? ""} onChange={(event) => update("q", event.target.value)} />
      <select aria-label="Sort models" value={filters.sort} onChange={(event) => update("sort", event.target.value)}>{sorts.filter(([value]) => OPENROUTER_SORTS.includes(value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="Enabled models" value={filters.enabled} onChange={(event) => update("enabled", event.target.value)}><option value="all">All</option><option value="enabled">Enabled</option></select>
      <button type="button" className={filters.input_modalities?.includes("image") ? "active" : ""} onClick={() => update("input_modalities", filters.input_modalities?.includes("image") ? "" : "image")}>Image input</button>
      <button type="button" className={filters.supported_parameters?.includes("reasoning") ? "active" : ""} onClick={() => update("supported_parameters", filters.supported_parameters?.includes("reasoning") ? "" : "reasoning")}>Reasoning</button>
      <select aria-label="Price" value={filters.max_price === "0" ? "free" : filters.min_price === "0.000001" ? "paid" : ""} onChange={(event) => setFilters((current) => ({ ...current, min_price: event.target.value === "paid" ? "0.000001" : "", max_price: event.target.value === "free" ? "0" : "" }))}><option value="">Free / paid</option><option value="free">Free</option><option value="paid">Paid</option></select>
      <button type="button" onClick={() => setAdvanced((value) => !value)}>Advanced filters</button>
    </div>
    {advanced && <div className="model-advanced">
      <label>Category<input value={filters.category ?? ""} onChange={(e) => update("category", e.target.value)} /></label>
      <label>Input modalities<select multiple value={(filters.input_modalities ?? "").split(",").filter(Boolean)} onChange={(e) => update("input_modalities", [...e.target.selectedOptions].map((o) => o.value).join(","))}>{["text","image","audio","file"].map((v)=><option key={v}>{v}</option>)}</select></label>
      <label>Additional output<select multiple value={(filters.output_modalities ?? "").split(",").filter(Boolean)} onChange={(e) => update("output_modalities", [...e.target.selectedOptions].map((o) => o.value).join(","))}>{["image","audio"].map((v)=><option key={v}>{v}</option>)}</select></label>
      <label>Supported parameters<input placeholder="reasoning, structured_outputs" value={filters.supported_parameters ?? ""} onChange={(e) => update("supported_parameters", e.target.value)} /></label>
      <label>Minimum context<input type="number" min="0" value={filters.context ?? ""} onChange={(e) => update("context", e.target.value)} /></label>
      <label>Min prompt $/1M<input type="number" min="0" step="0.01" value={filters.min_price ?? ""} onChange={(e) => update("min_price", e.target.value)} /></label>
      <label>Max prompt $/1M<input type="number" min="0" step="0.01" value={filters.max_price ?? ""} onChange={(e) => update("max_price", e.target.value)} /></label>
      <label>Architecture<select value={filters.arch ?? ""} onChange={(e) => update("arch", e.target.value)}><option value="">Any</option>{catalog?.facets.architectures.map((v)=><option key={v}>{v}</option>)}</select></label>
      <label>Author<select value={filters.model_authors ?? ""} onChange={(e) => update("model_authors", e.target.value)}><option value="">Any</option>{catalog?.facets.authors.map((v)=><option key={v}>{v}</option>)}</select></label>
      <label>Hosting provider<select value={filters.providers ?? ""} onChange={(e) => update("providers", e.target.value)}><option value="">Any</option>{catalog?.facets.providers.map((v)=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>Distillable<select value={filters.distillable ?? ""} onChange={(e)=>update("distillable",e.target.value)}><option value="">Any</option><option value="true">Yes</option><option value="false">No</option></select></label>
      <label>Zero data retention<select value={filters.zdr ?? ""} onChange={(e)=>update("zdr",e.target.value)}><option value="">Any</option><option value="true">Required</option></select></label>
      <label>Region<select value={filters.region ?? ""} onChange={(e)=>update("region",e.target.value)}><option value="">Any</option><option value="eu">EU</option></select></label>
    </div>}
    {!!chips.length && <div className="model-filter-chips">{chips.map(([key,value])=><button type="button" key={key} onClick={()=>update(key,"")}>{key}: {value} ×</button>)}<button type="button" onClick={()=>setFilters({sort:"most-popular",enabled:"all"})}>Reset all</button></div>}
    {catalog?.cache.stale && <p className="model-state">Showing stale cached results from {new Date(catalog.cache.fetchedAt).toLocaleString()}.</p>}
    {catalog?.providerError && <p className="model-state">{catalog.providerError}</p>}{error && <p className="model-state error">{error}</p>}
    {loading && !catalog ? <p className="model-state">Loading models…</p> : !catalog?.models.length ? <p className="model-state">No eligible models match these filters.</p> : <div className="model-card-grid">{catalog.models.map((model)=><article className="model-card" key={chatModelIdentity(model.ref)}>
      <div><strong>{model.displayName}</strong><button type="button" role="switch" aria-checked={model.enabled} onClick={()=>void toggle(model)}>{model.enabled ? "Enabled" : "Enable"}</button></div>
      <code>{model.ref.model}</code><p>{model.inputModalities.join(", ")} → {model.outputModalities.join(", ")} · Tools · {context(model.contextLength)}</p>
      <span>{model.author ?? "Unknown author"} · {model.architecture ?? "Unknown architecture"}</span>
      <span>Reasoning: {model.reasoningRequired ? "Required · " : ""}{model.supportedEfforts.map((v)=>effortLabels[v]).join(", ") || "Unavailable"}</span>
      <small>Input {money(model.pricing?.inputUsdPerMillion ?? null)} · Cache {money(model.pricing?.cachedInputUsdPerMillion ?? null)} · Output {money(model.pricing?.outputUsdPerMillion ?? null)} · Request {money(model.pricing?.requestUsd ?? null)} · Reasoning {money(model.pricing?.reasoningUsdPerMillion ?? null)}</small>
    </article>)}</div>}
  </div>;
}
