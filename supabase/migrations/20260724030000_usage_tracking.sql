create table if not exists public.chat_model_pricing (
  provider text not null,
  model text not null,
  label text not null,
  input_usd_per_million numeric(18, 9) not null check (input_usd_per_million >= 0),
  cached_input_usd_per_million numeric(18, 9) check (cached_input_usd_per_million is null or cached_input_usd_per_million >= 0),
  output_usd_per_million numeric(18, 9) not null check (output_usd_per_million >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);

insert into public.chat_model_pricing (
  provider,
  model,
  label,
  input_usd_per_million,
  cached_input_usd_per_million,
  output_usd_per_million
)
values
  ('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 0.14, 0.0028, 0.28),
  ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 0.435, 0.003625, 0.87)
on conflict (provider, model) do nothing;

create table if not exists public.chat_usage_records (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  provider text not null,
  model text not null,
  request_kind text not null check (request_kind in ('chat', 'title')),
  request_id text not null,
  round integer not null check (round >= 0),
  recorded_at timestamptz not null default now(),
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cached_prompt_tokens bigint not null default 0 check (cached_prompt_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  cost_usd numeric(24, 12),
  usage_source text not null check (usage_source in ('exact', 'estimated')),
  input_usd_per_million numeric(18, 9),
  cached_input_usd_per_million numeric(18, 9),
  output_usd_per_million numeric(18, 9),
  pricing_label text
);

create index if not exists chat_usage_records_owner_time
  on public.chat_usage_records(owner_id, recorded_at desc);
create index if not exists chat_usage_records_owner_model
  on public.chat_usage_records(owner_id, provider, model, recorded_at desc);
create unique index if not exists chat_usage_records_request_round
  on public.chat_usage_records(owner_id, provider, request_kind, request_id, round);

create table if not exists public.chat_usage_outbox (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  provider text not null,
  model text not null,
  request_kind text not null check (request_kind in ('chat', 'title')),
  request_id text not null,
  round integer not null check (round >= 0),
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cached_prompt_tokens bigint not null default 0 check (cached_prompt_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  usage_source text not null check (usage_source in ('exact', 'estimated')),
  recorded_at timestamptz not null default now(),
  unique (owner_id, provider, request_kind, request_id, round)
);
create index if not exists chat_usage_outbox_owner
  on public.chat_usage_outbox(owner_id, id);

alter table public.chat_model_pricing enable row level security;
alter table public.chat_usage_records enable row level security;
alter table public.chat_usage_outbox enable row level security;

-- These tables are server-only. The service-role client bypasses RLS;
-- no public policies are intentional.
