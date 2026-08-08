-- Clean local PostgreSQL schema for the server-only application database.
-- Auth.js and local filesystem storage are layered above this PostgreSQL schema.

create table if not exists public.chat_conversations (
  owner_id uuid not null,
  conversation_id text not null,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id)
);

create table if not exists public.chat_turns (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  position integer not null check (position >= 0),
  active_version integer not null default 0 check (active_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, turn_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.chat_message_versions (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  version_id text not null,
  version_index integer not null check (version_index >= 0),
  parent_version_id text,
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, version_id),
  foreign key (owner_id, conversation_id, turn_id)
    references public.chat_turns(owner_id, conversation_id, turn_id) on delete cascade
);

create table if not exists public.chat_jobs (
  owner_id uuid not null,
  conversation_id text not null,
  job_id text not null,
  idempotency_key text not null,
  request jsonb not null,
  status text not null check (status in ('queued','running','awaiting_approval','completed','failed','cancelled')),
  error text,
  usage jsonb,
  final_output text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_token uuid,
  primary key (owner_id, conversation_id, job_id),
  unique (owner_id, conversation_id, idempotency_key)
);

create table if not exists public.chat_messages (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  version_id text not null,
  message_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  reasoning text,
  activities jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  thinking_enabled boolean,
  thinking_duration_ms integer,
  status text check (status in ('streaming', 'complete', 'error', 'cancelled')),
  error text,
  job_id text,
  last_sequence bigint not null default 0,
  trace_round integer,
  annotations jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  documents jsonb not null default '[]'::jsonb,
  todos jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, message_id),
  unique (owner_id, conversation_id, version_id, role),
  foreign key (owner_id, conversation_id, turn_id)
    references public.chat_turns(owner_id, conversation_id, turn_id) on delete cascade,
  foreign key (owner_id, conversation_id, version_id)
    references public.chat_message_versions(owner_id, conversation_id, version_id) on delete cascade
);

create table if not exists public.chat_job_events (
  owner_id uuid not null,
  conversation_id text not null,
  job_id text not null,
  sequence bigint generated always as identity,
  event_index bigint,
  event_id text,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, job_id, sequence),
  foreign key (owner_id, conversation_id, job_id)
    references public.chat_jobs(owner_id, conversation_id, job_id) on delete cascade
);

create table if not exists public.chat_model_preferences (
  owner_id uuid not null,
  conversation_id text not null,
  provider text not null default 'deepseek' check (provider in ('deepseek', 'openrouter')),
  model text not null,
  thinking boolean not null,
  reasoning_effort text not null check (reasoning_effort in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id)
);

create table if not exists public.chat_user_preferences (
  owner_id uuid primary key,
  user_presence text not null default '',
  vision_model jsonb,
  automation_model jsonb,
  automation_thinking boolean not null default false,
  focused_context_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.chat_usage_records (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  provider text not null,
  model text not null,
  request_kind text not null check (request_kind in ('chat','title','reasoning_summary','image_analysis','image_text_analysis','image_visual_analysis','image_followup','chat_summary','chat_recall','dreaming','todo_planner','deep_research','automation','context_router')),
  request_id text not null,
  round integer not null check (round >= 0),
  recorded_at timestamptz not null default now(),
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cached_prompt_tokens bigint not null default 0 check (cached_prompt_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  cost_usd numeric(24,12),
  usage_source text not null check (usage_source in ('exact','estimated')),
  input_usd_per_million numeric(18,9),
  cached_input_usd_per_million numeric(18,9),
  output_usd_per_million numeric(18,9),
  pricing_label text,
  conversation_id text,
  job_id text,
  exact_cost_usd numeric,
  pricing_snapshot jsonb,
  unpriced boolean not null default false,
  unique (owner_id, provider, request_kind, request_id, round)
);

create table if not exists public.chat_usage_outbox (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  provider text not null,
  model text not null,
  request_kind text not null check (request_kind in ('chat','title','reasoning_summary','image_analysis','image_text_analysis','image_visual_analysis','image_followup','chat_summary','chat_recall','dreaming','todo_planner','deep_research','automation','context_router')),
  request_id text not null,
  round integer not null check (round >= 0),
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  cached_prompt_tokens bigint not null default 0 check (cached_prompt_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  usage_source text not null check (usage_source in ('exact','estimated')),
  recorded_at timestamptz not null default now(),
  conversation_id text,
  job_id text,
  exact_cost_usd numeric,
  pricing_snapshot jsonb,
  unpriced boolean not null default false,
  unique (owner_id, provider, request_kind, request_id, round)
);

create table if not exists public.chat_image_uploads (
  owner_id uuid not null,
  conversation_id text not null,
  image_id text not null,
  user_message_id text not null,
  job_id text,
  storage_path text not null,
  name text,
  content_type text not null check (content_type in ('image/png','image/jpeg','image/webp','image/gif')),
  size bigint not null check (size >= 0),
  status text not null check (status in ('processing','complete','failed')),
  analysis jsonb,
  error text,
  content_hash text,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, image_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade,
  unique (owner_id, storage_path)
);

create table if not exists public.chat_documents (
  owner_id uuid not null,
  conversation_id text not null,
  document_id text not null,
  user_message_id text,
  job_id text,
  storage_path text not null unique,
  filename text not null,
  content_type text not null check (content_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size bigint not null check (size between 1 and 26214400),
  page_count integer not null check (page_count > 0),
  token_estimate integer not null check (token_estimate >= 0),
  status text not null check (status in ('processing','complete','failed')),
  has_images boolean not null default false,
  image_count integer not null default 0 check (image_count >= 0),
  analyzed_image_count integer not null default 0 check (analyzed_image_count between 0 and 4),
  image_analyses jsonb not null default '[]'::jsonb,
  project_id text,
  revision_id text,
  parent_revision_id text,
  origin text check (origin in ('generated','uploaded')),
  editable boolean not null default false,
  source_completeness text check (source_completeness in ('complete','entrypoint-only')),
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, document_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.chat_document_pages (
  owner_id uuid not null,
  conversation_id text not null,
  document_id text not null,
  page_number integer not null check (page_number > 0),
  text text not null,
  extraction_method text not null default 'native' check (extraction_method in ('native','ocr','blank')),
  failure jsonb,
  primary key (owner_id, conversation_id, document_id, page_number),
  foreign key (owner_id, conversation_id, document_id)
    references public.chat_documents(owner_id, conversation_id, document_id) on delete cascade
);

create table if not exists public.chat_document_projects (
  owner_id uuid not null,
  conversation_id text not null,
  project_id text not null,
  origin text not null check (origin in ('generated','uploaded')),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, project_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.chat_document_revisions (
  owner_id uuid not null,
  conversation_id text not null,
  project_id text not null,
  revision_id text not null,
  parent_revision_id text,
  rendered_document_id text not null,
  entrypoint text not null,
  output_path text not null,
  output_filename text not null,
  output_content_type text not null check (output_content_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  source_completeness text not null check (source_completeness in ('complete','entrypoint-only')),
  manifest jsonb not null,
  status text not null check (status in ('creating','complete','failed')),
  created_by_job_id text,
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, project_id, revision_id),
  foreign key (owner_id, conversation_id, project_id)
    references public.chat_document_projects(owner_id, conversation_id, project_id) on delete cascade,
  unique (owner_id, conversation_id, rendered_document_id)
);

create table if not exists public.chat_document_revision_files (
  owner_id uuid not null,
  conversation_id text not null,
  project_id text not null,
  revision_id text not null,
  relative_path text not null,
  storage_path text not null unique,
  content_type text not null,
  size bigint not null check (size between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, project_id, revision_id, relative_path),
  foreign key (owner_id, conversation_id, project_id, revision_id)
    references public.chat_document_revisions(owner_id, conversation_id, project_id, revision_id) on delete cascade
);

create table if not exists public.chat_conversation_summaries (
  owner_id uuid not null,
  conversation_id text not null,
  summary text not null default '',
  summary_revision bigint not null default 0 check (summary_revision >= 0),
  last_source_position integer not null default -1 check (last_source_position >= -1),
  last_source_version_id text,
  last_source_job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.chat_summary_jobs (
  owner_id uuid not null,
  conversation_id text not null,
  source_job_id text not null,
  source_turn_id text not null,
  source_version_id text not null,
  source_position integer not null check (source_position >= 0),
  mode text not null check (mode in ('incremental','rebuild')),
  status text not null check (status in ('queued','running','completed','failed','superseded')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (owner_id, conversation_id, source_job_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade,
  foreign key (owner_id, conversation_id, source_job_id)
    references public.chat_jobs(owner_id, conversation_id, job_id) on delete cascade
);

create table if not exists public.chat_todo_lists (
  owner_id uuid not null,
  conversation_id text not null,
  revision integer not null default 0 check (revision >= 0),
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.openrouter_catalog_cache (
  singleton boolean primary key default true check (singleton),
  models jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.openrouter_provider_cache (
  singleton boolean primary key default true check (singleton),
  providers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.openrouter_catalog_query_cache (
  query_hash text primary key,
  canonical_query text not null,
  models jsonb not null,
  providers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.enabled_openrouter_models (
  owner_id uuid not null,
  model text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, model)
);

create table if not exists public.user_memory_profiles (
  owner_id uuid primary key,
  revision bigint not null default 0 check (revision >= 0),
  dreaming_cycle_count integer not null default 0,
  consolidated_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.user_memory_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  parent_id uuid,
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text not null,
  created_by text not null check (created_by in ('dreaming','agent')),
  source_chat_id text not null,
  source_job_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (owner_id) references public.user_memory_profiles(owner_id) on delete cascade,
  foreign key (parent_id) references public.user_memory_folders(id)
);
create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  folder_id uuid not null,
  content text not null check (char_length(content) between 1 and 2000),
  content_fingerprint text not null,
  source_chat_id text not null,
  source_job_id text not null,
  writer text not null check (writer in ('dreaming','agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (owner_id) references public.user_memory_profiles(owner_id) on delete cascade,
  foreign key (folder_id) references public.user_memory_folders(id)
);
create table if not exists public.user_memory_revisions (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  profile_revision bigint not null,
  memory_id uuid,
  folder_id uuid,
  operation text not null check (operation in ('create_folder','add','edit','move','delete','merge')),
  before_state jsonb,
  after_state jsonb,
  source_chat_id text not null,
  source_job_id text not null,
  writer text not null check (writer in ('dreaming','agent')),
  dreaming_run_id uuid,
  action_index integer,
  created_at timestamptz not null default now(),
  unique (dreaming_run_id, action_index)
);
create table if not exists public.dreaming_completed_jobs (
  sequence bigint generated always as identity,
  owner_id uuid not null,
  job_id text not null,
  conversation_id text not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, job_id),
  unique (sequence)
);
create table if not exists public.dreaming_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  status text not null check (status in ('queued','running','completed','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  profile_revision bigint,
  model text,
  action_plan jsonb,
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.dreaming_run_sources (
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  owner_id uuid not null,
  job_id text not null,
  sequence bigint not null,
  conversation_id text not null,
  completed_at timestamptz not null,
  primary key (run_id, job_id),
  unique (owner_id, job_id),
  foreign key (owner_id, job_id) references public.dreaming_completed_jobs(owner_id, job_id) on delete cascade
);
create table if not exists public.dreaming_applied_actions (
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  action_index integer not null check (action_index >= 0),
  completed_at timestamptz not null default now(),
  primary key (run_id, action_index)
);
create table if not exists public.dreaming_consolidations (
  owner_id uuid not null references public.user_memory_profiles(owner_id) on delete cascade,
  cycle_number integer not null check (cycle_number > 0),
  source_run_ids uuid[] not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  prompt text not null default '',
  model text,
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_id, cycle_number)
);
create table if not exists public.dreaming_cycle_runs (
  owner_id uuid not null references public.user_memory_profiles(owner_id) on delete cascade,
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  cycle_number integer not null check (cycle_number > 0),
  created_at timestamptz not null default now(),
  primary key (owner_id, run_id)
);

create table if not exists public.user_skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  builtin_key text,
  builtin_version integer check (builtin_version is null or builtin_version > 0),
  customized boolean not null default false,
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 200),
  instructions text not null check (char_length(instructions) between 1 and 12000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, builtin_key),
  unique (id, owner_id),
  check ((builtin_key is null and builtin_version is null and customized) or (builtin_key is not null and builtin_version is not null))
);

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('report','live_check')),
  instructions text not null check (char_length(instructions) between 1 and 12000),
  schedule jsonb not null,
  time_zone text not null,
  status text not null default 'active' check (status in ('active','paused')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_outcome text check (last_outcome in ('notified','no_match','failed')),
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  automation_id uuid not null references public.automations(id),
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued','running','notified','no_match','failed')),
  attempt_count integer not null default 0,
  lease_expires_at timestamptz,
  matched boolean,
  title text,
  output text,
  error text,
  conversation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (automation_id, scheduled_for)
);

create table if not exists public.research_page_cache (
  canonical_url text primary key,
  final_url text not null,
  content_hash text not null,
  content_type text not null,
  title text not null default '',
  markdown text not null,
  links jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  etag text,
  last_modified text,
  extractor text not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.google_calendar_credentials (
  owner_id uuid primary key,
  refresh_token_ciphertext text not null,
  refresh_token_nonce text not null,
  refresh_token_auth_tag text not null,
  scope text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_dm_channels (
  owner_id uuid not null,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{1,24}$'),
  discord_channel_id text not null check (discord_channel_id ~ '^[0-9]{1,24}$'),
  active_conversation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, discord_channel_id),
  unique (owner_id, discord_user_id)
);
create table if not exists public.discord_dm_messages (
  owner_id uuid not null,
  discord_message_id text not null check (discord_message_id ~ '^[0-9]{1,24}$'),
  discord_user_id text not null,
  discord_channel_id text not null,
  response_message_id text not null,
  conversation_id text,
  job_id text,
  content text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  status text not null check (status in ('processing','running','completed','failed')),
  error text,
  output text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, discord_message_id)
);
create table if not exists public.discord_automation_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  automation_run_id uuid not null references public.automation_runs(id),
  conversation_id text not null,
  title text not null check (char_length(title) between 1 and 160),
  message text not null,
  status text not null default 'pending' check (status in ('pending','delivering','delivered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  discord_channel_id text,
  discord_message_id text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, automation_run_id)
);

create table if not exists public.connector_definitions (
  id text primary key,
  owner_id uuid,
  name text not null,
  description text not null,
  icon_url text,
  version text not null,
  provider text not null check (provider in ('managed','remote_mcp')),
  auth_type text not null check (auth_type in ('oauth2','api_key','none')),
  capabilities jsonb not null default '[]'::jsonb,
  default_approval jsonb not null,
  endpoint_url text,
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','unavailable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.connector_installations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null references public.connector_definitions(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, connector_id)
);
create table if not exists public.connector_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null references public.connector_definitions(id) on delete cascade,
  account_label text,
  account_email text,
  status text not null default 'connected' check (status in ('connected','reconnect_required','unavailable','disconnected')),
  is_default boolean not null default false,
  credentials_ciphertext text,
  credentials_nonce text,
  credentials_auth_tag text,
  credentials_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);
create table if not exists public.connector_tools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  connector_id text not null references public.connector_definitions(id) on delete cascade,
  connection_id uuid references public.connector_connections(id) on delete cascade,
  name text not null,
  description text not null,
  input_schema jsonb not null,
  access text not null check (access in ('read','write','destructive')),
  enabled boolean not null default true,
  connector_version text not null,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, connector_id, connection_id, name)
);
create table if not exists public.connector_permissions (
  owner_id uuid not null,
  connector_id text not null,
  tool_name text not null,
  enabled boolean not null default true,
  approval_mode text not null check (approval_mode in ('never','always')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, connector_id, tool_name)
);
create table if not exists public.connector_call_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null,
  connection_id uuid,
  tool_name text not null,
  access text not null,
  arguments jsonb not null default '{}'::jsonb,
  ok boolean,
  error_code text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create table if not exists public.connector_approval_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  job_id text,
  conversation_id text,
  connector_id text not null,
  connection_id uuid not null,
  tool_name text not null,
  description text not null,
  access text not null,
  important_arguments jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','allow_once','always_allow','deny','expired')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.custom_tools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  description text not null,
  instructions text not null default '',
  input_schema jsonb not null,
  python_source text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name),
  unique (id, owner_id)
);
create table if not exists public.custom_tool_secrets (
  tool_id uuid not null,
  owner_id uuid not null,
  name text not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tool_id, name),
  foreign key (tool_id, owner_id) references public.custom_tools(id, owner_id) on delete cascade
);

create unique index if not exists chat_job_events_job_ordinal on public.chat_job_events(owner_id, conversation_id, job_id, event_index);
create unique index if not exists chat_job_events_event_id on public.chat_job_events(owner_id, conversation_id, job_id, event_id);
create index if not exists chat_job_events_replay on public.chat_job_events(owner_id, conversation_id, job_id, event_index);
create index if not exists chat_jobs_claimable on public.chat_jobs(status, lease_expires_at, created_at);
create index if not exists chat_conversations_updated on public.chat_conversations(owner_id, updated_at desc);
create index if not exists chat_messages_conversation on public.chat_messages(owner_id, conversation_id, updated_at desc);
create index if not exists chat_messages_jobs on public.chat_messages(owner_id, conversation_id, job_id);
create index if not exists chat_messages_streaming_conversation on public.chat_messages(owner_id, conversation_id) where role = 'assistant' and status = 'streaming';
create index if not exists chat_messages_image_attachments on public.chat_messages using gin (attachments);
create index if not exists chat_image_uploads_owner_conversation on public.chat_image_uploads(owner_id, conversation_id, updated_at desc);
create index if not exists chat_image_uploads_processing_claim on public.chat_image_uploads(owner_id, conversation_id, claim_expires_at) where status = 'processing';
create index if not exists chat_summary_jobs_due on public.chat_summary_jobs(owner_id, conversation_id, status, next_attempt_at, source_position);
create unique index if not exists chat_summary_jobs_one_running on public.chat_summary_jobs(owner_id, conversation_id) where status = 'running';
create index if not exists chat_todo_lists_updated on public.chat_todo_lists(owner_id, updated_at desc);
create index if not exists chat_usage_records_owner_time on public.chat_usage_records(owner_id, recorded_at desc);
create index if not exists chat_usage_records_owner_model on public.chat_usage_records(owner_id, provider, model, recorded_at desc);
create index if not exists chat_usage_outbox_owner on public.chat_usage_outbox(owner_id, id);
create index if not exists openrouter_catalog_query_cache_fetched_idx on public.openrouter_catalog_query_cache(fetched_at);
create index if not exists enabled_openrouter_models_owner_enabled_idx on public.enabled_openrouter_models(owner_id, enabled);
create unique index if not exists user_memory_folders_active_name on public.user_memory_folders(owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name) where deleted_at is null;
create unique index if not exists user_memories_active_fingerprint on public.user_memories(owner_id, folder_id, content_fingerprint) where deleted_at is null;
create index if not exists user_memories_folder on public.user_memories(owner_id, folder_id, updated_at desc);
create index if not exists user_memory_revisions_owner on public.user_memory_revisions(owner_id, id desc);
create index if not exists dreaming_runs_due on public.dreaming_runs(owner_id, status, created_at);
create index if not exists dreaming_runs_reliability_status on public.dreaming_runs(owner_id, status, updated_at desc);
create unique index if not exists user_skills_owner_active_name on public.user_skills(owner_id, normalized_name) where deleted_at is null;
create index if not exists user_skills_owner_updated on public.user_skills(owner_id, updated_at desc) where deleted_at is null;
create index if not exists automations_due on public.automations(next_run_at) where status = 'active' and deleted_at is null;
create index if not exists automations_owner_updated on public.automations(owner_id, updated_at desc) where deleted_at is null;
create index if not exists automation_runs_recovery on public.automation_runs(status, lease_expires_at);
create index if not exists research_page_cache_hash on public.research_page_cache(content_hash);
create index if not exists research_page_cache_expiry on public.research_page_cache(expires_at);
create index if not exists discord_dm_messages_pending on public.discord_dm_messages(owner_id, status, created_at);
create index if not exists discord_automation_notifications_pending on public.discord_automation_notifications(next_attempt_at, created_at) where status in ('pending','delivering');
create index if not exists connector_connections_owner on public.connector_connections(owner_id, connector_id, status);
create index if not exists connector_tools_owner on public.connector_tools(owner_id, connector_id, enabled);
create index if not exists connector_approval_owner on public.connector_approval_requests(owner_id, status);
create index if not exists connector_call_logs_owner on public.connector_call_logs(owner_id, created_at desc);
create index if not exists custom_tools_owner_enabled on public.custom_tools(owner_id, enabled);
create index if not exists custom_tool_secrets_owner on public.custom_tool_secrets(owner_id, tool_id);

create or replace function public.assign_chat_job_event_index()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.event_index is null then
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text || ':' || new.conversation_id || ':' || new.job_id, 704));
    select coalesce(max(event_index), 0) + 1 into new.event_index
      from public.chat_job_events
      where owner_id = new.owner_id and conversation_id = new.conversation_id and job_id = new.job_id;
  end if;
  if new.event_id is null then new.event_id := new.job_id || ':' || new.event_index::text; end if;
  return new;
end;
$$;
drop trigger if exists assign_chat_job_event_metadata on public.chat_job_events;
drop trigger if exists assign_chat_job_event_index on public.chat_job_events;
create trigger assign_chat_job_event_index before insert on public.chat_job_events for each row execute function public.assign_chat_job_event_index();
alter table public.chat_job_events alter column event_index set not null;
alter table public.chat_job_events alter column event_id set not null;

create or replace function public.translate_chat_message_event_checkpoint()
returns trigger language plpgsql set search_path = public as $$
declare translated_index bigint;
begin
  if new.job_id is not null and new.last_sequence > 0 and (tg_op = 'INSERT' or new.last_sequence is distinct from old.last_sequence) then
    select event_index into translated_index from public.chat_job_events
      where owner_id = new.owner_id and conversation_id = new.conversation_id and job_id = new.job_id and sequence = new.last_sequence;
    if translated_index is not null then new.last_sequence := translated_index; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists translate_chat_message_event_checkpoint on public.chat_messages;
create trigger translate_chat_message_event_checkpoint before insert or update of last_sequence on public.chat_messages for each row execute function public.translate_chat_message_event_checkpoint();
