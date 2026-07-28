create table if not exists public.openrouter_catalog_cache (
  singleton boolean primary key default true check (singleton),
  models jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.openrouter_catalog_cache enable row level security;

create table if not exists public.openrouter_provider_cache (
  singleton boolean primary key default true check (singleton),
  providers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.openrouter_provider_cache enable row level security;

create table if not exists public.openrouter_catalog_query_cache (
  query_hash text primary key,
  canonical_query text not null,
  models jsonb not null,
  providers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists openrouter_catalog_query_cache_fetched_idx on public.openrouter_catalog_query_cache(fetched_at);
alter table public.openrouter_catalog_query_cache enable row level security;

create table if not exists public.enabled_openrouter_models (
  owner_id uuid not null,
  model text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, model)
);
create index if not exists enabled_openrouter_models_owner_enabled_idx on public.enabled_openrouter_models(owner_id, enabled);
alter table public.enabled_openrouter_models enable row level security;

alter table public.chat_model_preferences add column if not exists provider text;
update public.chat_model_preferences set provider = 'deepseek' where provider is null;
alter table public.chat_model_preferences alter column provider set default 'deepseek';
alter table public.chat_model_preferences alter column provider set not null;
alter table public.chat_model_preferences drop constraint if exists chat_model_preferences_model_check;
alter table public.chat_model_preferences drop constraint if exists chat_model_preferences_reasoning_effort_check;
alter table public.chat_model_preferences add constraint chat_model_preferences_provider_check check (provider in ('deepseek', 'openrouter'));
alter table public.chat_model_preferences add constraint chat_model_preferences_reasoning_effort_check check (reasoning_effort in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.chat_usage_records add column if not exists exact_cost_usd numeric;
alter table public.chat_usage_records add column if not exists pricing_snapshot jsonb;
alter table public.chat_usage_records add column if not exists unpriced boolean not null default false;
alter table public.chat_usage_outbox add column if not exists exact_cost_usd numeric;
alter table public.chat_usage_outbox add column if not exists pricing_snapshot jsonb;
alter table public.chat_usage_outbox add column if not exists unpriced boolean not null default false;
