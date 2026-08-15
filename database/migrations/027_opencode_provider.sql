-- OpenCode Zen as a third chat provider (free-tier OpenAI-compatible models).

alter table public.chat_model_preferences
  drop constraint if exists chat_model_preferences_provider_check;
alter table public.chat_model_preferences
  add constraint chat_model_preferences_provider_check
  check (provider in ('deepseek', 'openrouter', 'opencode'));

create table if not exists public.opencode_catalog_query_cache (
  query_hash text primary key,
  canonical_query text not null,
  models jsonb not null,
  providers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists opencode_catalog_query_cache_fetched_idx on public.opencode_catalog_query_cache(fetched_at);

create table if not exists public.enabled_opencode_models (
  owner_id uuid not null,
  model text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, model)
);
create index if not exists enabled_opencode_models_owner_enabled_idx on public.enabled_opencode_models(owner_id, enabled);

-- OpenCode Zen free-tier catalog pricing snapshot. All curated models are free
-- during their limited-time trial windows; requests priced with these rows are
-- exact at zero USD. Deployment catalog rows remain authoritative.
insert into public.chat_model_pricing (
  provider, model, label, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million
)
values
  ('opencode', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free', 0, 0, 0),
  ('opencode', 'mimo-v2.5-free', 'MiMo-V2.5 Free', 0, 0, 0),
  ('opencode', 'hy3-free', 'Hy3 Free', 0, 0, 0),
  ('opencode', 'laguna-s-2.1-free', 'Laguna S 2.1 Free', 0, 0, 0),
  ('opencode', 'nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', 0, 0, 0),
  ('opencode', 'nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', 0, 0, 0),
  ('opencode', 'big-pickle', 'Big Pickle', 0, 0, 0)
on conflict (provider, model) do nothing;
