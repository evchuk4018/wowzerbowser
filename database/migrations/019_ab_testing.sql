-- Owner-scoped A/B trials. Variant snapshots are immutable JSON documents;
-- comparison rows retain only opaque response identifiers and the randomized
-- display assignment so the voting surface can remain blind.

create table if not exists public.ab_test_trials (
  owner_id uuid not null,
  trial_id uuid not null default gen_random_uuid(),
  name text not null default '' check (char_length(name) <= 120),
  status text not null default 'active' check (status in ('active', 'stopped')),
  sampling_rate numeric(5,4) not null default 0.1000 check (sampling_rate > 0 and sampling_rate <= 1),
  created_at timestamptz not null default now(),
  stopped_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, trial_id),
  check ((status = 'active' and stopped_at is null) or (status = 'stopped' and stopped_at is not null))
);

create unique index if not exists ab_test_trials_one_active_per_owner
  on public.ab_test_trials(owner_id)
  where status = 'active';

create table if not exists public.ab_test_variants (
  owner_id uuid not null,
  trial_id uuid not null,
  variant_key text not null check (variant_key in ('a', 'b')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  primary key (owner_id, trial_id, variant_key),
  foreign key (owner_id, trial_id)
    references public.ab_test_trials(owner_id, trial_id) on delete cascade
);

create table if not exists public.ab_test_comparisons (
  owner_id uuid not null,
  trial_id uuid not null,
  comparison_id uuid not null default gen_random_uuid(),
  conversation_id text not null check (conversation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  turn_id text not null check (turn_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  display_a_variant text not null check (display_a_variant in ('a', 'b')),
  option_a_response_id text check (option_a_response_id is null or char_length(option_a_response_id) between 1 and 128),
  option_b_response_id text check (option_b_response_id is null or char_length(option_b_response_id) between 1 and 128),
  selected_label text check (selected_label is null or selected_label in ('a', 'b')),
  created_at timestamptz not null default now(),
  selected_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, comparison_id),
  foreign key (owner_id, trial_id)
    references public.ab_test_trials(owner_id, trial_id) on delete cascade,
  unique (owner_id, trial_id, conversation_id, turn_id),
  check ((selected_label is null and selected_at is null) or (selected_label is not null and selected_at is not null))
);

create index if not exists ab_test_trials_owner_created
  on public.ab_test_trials(owner_id, created_at desc);

create index if not exists ab_test_variants_owner_trial
  on public.ab_test_variants(owner_id, trial_id);

create index if not exists ab_test_comparisons_owner_trial_created
  on public.ab_test_comparisons(owner_id, trial_id, created_at desc);

create index if not exists ab_test_comparisons_owner_pending
  on public.ab_test_comparisons(owner_id, trial_id, created_at desc)
  where selected_label is null;
