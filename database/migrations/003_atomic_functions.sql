-- Transactional operations retained from the original hosted schema. These are
-- ordinary PostgreSQL functions called only by the server-side repository
-- layer; no hosted-provider roles are required.

create or replace function public.submit_and_claim_chat_job(
  p_owner_id uuid,
  p_request jsonb,
  p_attachments jsonb
) returns jsonb
language plpgsql set search_path = public as $$
declare
  persistence jsonb := p_request->'persistence';
  v_conversation_id text := p_request->>'conversationId';
  v_requested_job_id text := p_request->>'jobId';
  v_idempotency_key text := p_request->>'idempotencyKey';
  user_message jsonb := p_request->'messages'->-1;
  existing_job public.chat_jobs%rowtype;
  v_parent_version_id text;
  v_target_parent_version_id text;
  v_active_version_id text;
  v_target_parent_set boolean := false;
  v_turn record;
  now_at timestamptz := clock_timestamp();
begin
  if v_conversation_id is null or v_requested_job_id is null or v_idempotency_key is null
    or persistence is null or user_message->>'role' <> 'user'
    or jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' then
    raise exception 'Chat persistence metadata is incomplete.' using errcode = '22023';
  end if;

  select * into existing_job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = v_conversation_id
     and idempotency_key = v_idempotency_key for update;
  if found then
    return jsonb_build_object('jobId', existing_job.job_id, 'status', existing_job.status,
      'resumed', true, 'request', existing_job.request);
  end if;

  select message_version.version_id into v_parent_version_id
    from public.chat_turns preceding_turn
    join public.chat_message_versions message_version
      on message_version.owner_id = preceding_turn.owner_id
     and message_version.conversation_id = preceding_turn.conversation_id
     and message_version.turn_id = preceding_turn.turn_id
     and message_version.version_index = preceding_turn.active_version
   where preceding_turn.owner_id = p_owner_id
     and preceding_turn.conversation_id = v_conversation_id
     and preceding_turn.position = (persistence->>'turnIndex')::integer - 1;

  for v_turn in
    select turn_id, position, active_version from public.chat_turns
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and position >= (persistence->>'turnIndex')::integer
     order by position for update
  loop
    if not v_target_parent_set then
      v_target_parent_version_id := v_parent_version_id;
      v_target_parent_set := true;
    end if;
    update public.chat_message_versions set parent_version_id = v_parent_version_id
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and turn_id = v_turn.turn_id and parent_version_id is null;
    select version_id into v_active_version_id from public.chat_message_versions
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and turn_id = v_turn.turn_id and version_index = v_turn.active_version;
    v_parent_version_id := coalesce(v_active_version_id, v_parent_version_id);
  end loop;
  if not v_target_parent_set then v_target_parent_version_id := v_parent_version_id; end if;

  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, v_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;
  insert into public.chat_turns(owner_id, conversation_id, turn_id, position, active_version, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId',
      (persistence->>'turnIndex')::integer, (persistence->>'versionIndex')::integer, now_at)
    on conflict (owner_id, conversation_id, turn_id) do update
      set active_version = excluded.active_version, updated_at = excluded.updated_at;
  insert into public.chat_message_versions(owner_id, conversation_id, turn_id, version_id, version_index, parent_version_id)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      (persistence->>'versionIndex')::integer, v_target_parent_version_id) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, attachments, documents, activities, artifacts, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'userMessageId', 'user', coalesce(user_message->>'content', ''),
      p_attachments, coalesce(user_message->'documents', '[]'::jsonb), '[]'::jsonb, '[]'::jsonb,
      null, 0, now_at) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, reasoning, activities, artifacts, thinking_enabled, status, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'assistantMessageId', 'assistant', '', '', '[]'::jsonb, '[]'::jsonb,
      coalesce((p_request->>'thinking')::boolean, false), 'streaming', v_requested_job_id, 0, now_at)
    on conflict do nothing;
  insert into public.chat_jobs(owner_id, conversation_id, job_id, idempotency_key, request, status, updated_at)
    values (p_owner_id, v_conversation_id, v_requested_job_id, v_idempotency_key, p_request, 'queued', now_at);
  return jsonb_build_object('jobId', v_requested_job_id, 'status', 'queued', 'resumed', false, 'request', p_request);
exception when unique_violation then
  select * into existing_job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = v_conversation_id
     and idempotency_key = v_idempotency_key;
  if found then
    return jsonb_build_object('jobId', existing_job.job_id, 'status', existing_job.status,
      'resumed', true, 'request', existing_job.request);
  end if;
  raise;
end;
$$;

create or replace function public.submit_and_claim_chat_job(p_owner_id uuid, p_request jsonb)
returns jsonb language sql set search_path = public as $$
  select public.submit_and_claim_chat_job(p_owner_id, p_request,
    coalesce(p_request->'messages'->-1->'attachments', '[]'::jsonb));
$$;

create or replace function public.claim_chat_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid,
  p_lease_ms integer default 6000, p_max_attempts integer default 3
) returns jsonb language plpgsql set search_path = public as $$
declare
  job public.chat_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  lease_until timestamptz;
begin
  if p_lease_ms < 1000 or p_max_attempts < 1 then
    raise exception 'Invalid chat job lease configuration.' using errcode = '22023';
  end if;
  select * into job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id for update;
  if not found then return jsonb_build_object('claimed', false, 'status', 'missing'); end if;
  if job.status in ('completed','failed','cancelled') then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;
  if not (job.status = 'queued' or
    (job.status in ('running','awaiting_approval') and (job.lease_expires_at is null or job.lease_expires_at <= now_at))) then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;
  if job.attempt_count >= p_max_attempts then
    update public.chat_jobs set status='failed', error='The chat worker stopped before the job completed.',
      completed_at=now_at, lease_expires_at=null, lease_token=null, updated_at=now_at
     where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
    update public.chat_messages set status='error', error='The chat worker stopped before the job completed.', updated_at=now_at
     where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and role='assistant';
    return jsonb_build_object('claimed', true, 'status', 'failed', 'error', 'The chat worker stopped before the job completed.');
  end if;
  lease_until := now_at + make_interval(secs => p_lease_ms / 1000.0);
  update public.chat_jobs set status='running', started_at=coalesce(started_at, now_at), heartbeat_at=now_at,
    lease_expires_at=lease_until, lease_token=p_worker_token, attempt_count=attempt_count+1, updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  return jsonb_build_object('claimed', true, 'status', 'running', 'request', job.request,
    'leaseToken', p_worker_token::text, 'attemptCount', job.attempt_count + 1);
end;
$$;

create or replace function public.heartbeat_chat_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid, p_lease_ms integer default 6000
) returns jsonb language plpgsql set search_path = public as $$
declare changed integer; current_status text; now_at timestamptz := clock_timestamp();
begin
  update public.chat_jobs set heartbeat_at=now_at, lease_expires_at=now_at+make_interval(secs => p_lease_ms/1000.0), updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
     and lease_token=p_worker_token and lease_expires_at > now_at and status in ('running','awaiting_approval');
  get diagnostics changed = row_count;
  if changed=1 then return jsonb_build_object('active',true,'status','running'); end if;
  select status into current_status from public.chat_jobs where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  return jsonb_build_object('active',false,'status',coalesce(current_status,'missing'),'cancelled',current_status='cancelled');
end;
$$;

create or replace function public.append_chat_job_events(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid, p_events jsonb
) returns integer language plpgsql set search_path = public as $$
declare event_row jsonb; inserted_count integer := 0; next_index bigint;
begin
  perform 1 from public.chat_jobs where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
    and lease_token=p_worker_token and status in ('running','awaiting_approval') and lease_expires_at > clock_timestamp() for update;
  if not found then raise exception 'Chat job lease is no longer active.' using errcode='40001'; end if;
  select coalesce(max(event_index),0) into next_index from public.chat_job_events
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  for event_row in select value from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) loop
    if event_row->>'eventIndex' is null then next_index := next_index + 1; else next_index := (event_row->>'eventIndex')::bigint; end if;
    insert into public.chat_job_events(owner_id,conversation_id,job_id,event_id,event_index,event)
      values (p_owner_id,p_conversation_id,p_job_id,coalesce(event_row->>'eventId',p_job_id||':'||next_index),next_index,event_row->'event')
      on conflict (owner_id,conversation_id,job_id,event_id) do nothing;
    if found then inserted_count := inserted_count + 1; end if;
  end loop;
  return inserted_count;
end;
$$;

create or replace function public.complete_chat_job_and_finalize_message(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid, p_status text,
  p_error text default null, p_usage jsonb default null, p_final_output text default null
) returns jsonb language plpgsql set search_path = public as $$
declare current_job public.chat_jobs%rowtype; now_at timestamptz := clock_timestamp();
begin
  if p_status not in ('completed','failed','cancelled') then raise exception 'Invalid terminal chat job status.' using errcode='22023'; end if;
  select * into current_job from public.chat_jobs where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id for update;
  if not found then return jsonb_build_object('applied',false,'status','missing'); end if;
  if current_job.status in ('completed','failed','cancelled') then return jsonb_build_object('applied',false,'status',current_job.status); end if;
  if current_job.lease_token is distinct from p_worker_token or current_job.lease_expires_at is null or current_job.lease_expires_at <= now_at then
    return jsonb_build_object('applied',false,'status',current_job.status,'leaseLost',true);
  end if;
  update public.chat_jobs set status=p_status,error=p_error,usage=p_usage,final_output=p_final_output,completed_at=now_at,
    lease_expires_at=null,lease_token=null,heartbeat_at=now_at,updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  update public.chat_messages set content=case when p_final_output is null then content else p_final_output end,
    status=case p_status when 'completed' then 'complete' when 'cancelled' then 'cancelled' else 'error' end,
    error=p_error,updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and role='assistant';
  update public.chat_conversations set updated_at=now_at where owner_id=p_owner_id and conversation_id=p_conversation_id;
  return jsonb_build_object('applied',true,'status',p_status);
end;
$$;

create or replace function public.cancel_chat_job_and_finalize_message(p_owner_id uuid, p_conversation_id text, p_job_id text)
returns jsonb language plpgsql set search_path = public as $$
declare changed integer; now_at timestamptz := clock_timestamp();
begin
  update public.chat_jobs set status='cancelled',completed_at=now_at,lease_expires_at=null,lease_token=null,heartbeat_at=now_at,updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and status in ('queued','running','awaiting_approval');
  get diagnostics changed = row_count;
  if changed=1 then
    update public.chat_messages set status='cancelled',error=null,updated_at=now_at where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and role='assistant';
    update public.chat_conversations set updated_at=now_at where owner_id=p_owner_id and conversation_id=p_conversation_id;
  end if;
  return jsonb_build_object('applied',changed=1,'status',case when changed=1 then 'cancelled' else 'not_active' end);
end;
$$;

create or replace function public.register_chat_document(
  p_owner_id uuid, p_conversation_id text, p_document jsonb, p_user_message_id text, p_job_id text, p_pages jsonb,
  p_storage_path text
) returns jsonb language plpgsql set search_path = public as $$
declare page_total integer; distinct_pages integer; min_page integer; max_page integer;
  expected_pages integer := (p_document->>'pageCount')::integer; now_at timestamptz := clock_timestamp(); v_document_id text := p_document->>'id';
begin
  if v_document_id is null or expected_pages is null or expected_pages < 1 or jsonb_typeof(p_pages) <> 'array' then
    raise exception 'Document registration metadata is incomplete.' using errcode='22023';
  end if;
  insert into public.chat_conversations(owner_id,conversation_id,title,updated_at) values(p_owner_id,p_conversation_id,'New conversation',now_at)
    on conflict(owner_id,conversation_id) do update set updated_at=excluded.updated_at;
  insert into public.chat_documents(owner_id,conversation_id,document_id,user_message_id,job_id,storage_path,filename,content_type,size,page_count,token_estimate,has_images,image_count,analyzed_image_count,image_analyses,project_id,revision_id,parent_revision_id,origin,editable,source_completeness,status)
    values(p_owner_id,p_conversation_id,v_document_id,p_user_message_id,p_job_id,p_storage_path,p_document->>'name',p_document->>'contentType',(p_document->>'size')::bigint,expected_pages,(p_document->>'tokenEstimate')::integer,coalesce((p_document->>'hasImages')::boolean,false),coalesce((p_document->>'imageCount')::integer,0),coalesce((p_document->>'analyzedImageCount')::integer,0),coalesce(p_document->'imageAnalyses','[]'::jsonb),p_document->>'projectId',p_document->>'revisionId',p_document->>'parentRevisionId',p_document->>'origin',coalesce((p_document->>'editable')::boolean,false),p_document->>'sourceCompleteness','processing')
    on conflict(owner_id,conversation_id,document_id) do update set user_message_id=excluded.user_message_id,job_id=excluded.job_id,filename=excluded.filename,content_type=excluded.content_type,size=excluded.size,page_count=excluded.page_count,token_estimate=excluded.token_estimate,has_images=excluded.has_images,image_count=excluded.image_count,analyzed_image_count=excluded.analyzed_image_count,image_analyses=excluded.image_analyses,project_id=excluded.project_id,revision_id=excluded.revision_id,parent_revision_id=excluded.parent_revision_id,origin=excluded.origin,editable=excluded.editable,source_completeness=excluded.source_completeness,status='processing';
  delete from public.chat_document_pages where owner_id=p_owner_id and conversation_id=p_conversation_id and document_id=v_document_id;
  insert into public.chat_document_pages(owner_id,conversation_id,document_id,page_number,text,extraction_method,failure)
    select p_owner_id,p_conversation_id,v_document_id,(page->>'pageNumber')::integer,coalesce(page->>'text',''),coalesce(page->>'extractionMethod','native'),page->'failure' from jsonb_array_elements(p_pages) pages(page);
  select count(*),count(distinct page_number),min(page_number),max(page_number) into page_total,distinct_pages,min_page,max_page from public.chat_document_pages where owner_id=p_owner_id and conversation_id=p_conversation_id and document_id=v_document_id;
  if page_total<>expected_pages or distinct_pages<>expected_pages or min_page<>1 or max_page<>expected_pages then raise exception 'Document page registration is incomplete.' using errcode='22023'; end if;
  update public.chat_documents set status='complete' where owner_id=p_owner_id and conversation_id=p_conversation_id and document_id=v_document_id;
  return jsonb_build_object('documentId',v_document_id,'status','complete');
end;
$$;

create or replace function public.list_chat_conversations_fast(p_owner_id uuid)
returns table(conversation_id text,title text,updated_at timestamptz,has_messages boolean,is_streaming boolean)
language sql stable set search_path=public as $$
 select c.conversation_id,c.title,c.updated_at,
   exists(select 1 from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id),
   exists(select 1 from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id and m.role='assistant' and m.status='streaming')
 from public.chat_conversations c where c.owner_id=p_owner_id order by c.updated_at desc;
$$;

create or replace function public.search_chat_conversations(p_owner_id uuid,p_query text)
returns table(conversation_id text,title text,updated_at timestamptz,preview text)
language sql stable set search_path=public as $$
 with conversation_text as (
   select c.conversation_id,c.title,c.updated_at,s.summary,
     coalesce(nullif(s.summary,''),(select m.content from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id and m.content<>'' order by m.updated_at desc limit 1),'') as preview,
     lower(c.title||' '||coalesce(s.summary,' ')||' '||coalesce(messages.searchable_content,'')) as searchable_text
   from public.chat_conversations c left join public.chat_conversation_summaries s on s.owner_id=c.owner_id and s.conversation_id=c.conversation_id
   left join lateral (select string_agg(m.content,' ') searchable_content from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id) messages on true
   where c.owner_id=p_owner_id
 )
 select conversation_id,title,updated_at,left(preview,240) from conversation_text
 where nullif(trim(p_query),'') is null or not exists(select 1 from regexp_split_to_table(lower(trim(p_query)),'\s+') term where term<>'' and searchable_text not like '%'||term||'%')
 order by updated_at desc;
$$;

create or replace function public.claim_due_automations(p_limit integer default 4)
returns setof public.automation_runs language plpgsql set search_path=public as $$
declare candidate public.automations%rowtype; claimed public.automation_runs%rowtype;
begin
  for claimed in update public.automation_runs set status='running',attempt_count=attempt_count+1,lease_expires_at=now()+interval '5 minutes',updated_at=now()
   where id in (select id from public.automation_runs where status='running' and lease_expires_at<now() order by scheduled_for limit greatest(0,least(p_limit,8)) for update skip locked) returning * loop
    return next claimed; p_limit:=p_limit-1;
  end loop;
  if p_limit<=0 then return; end if;
  for candidate in select * from public.automations where status='active' and deleted_at is null and next_run_at<=now() order by next_run_at limit greatest(0,least(p_limit,8)) for update skip locked loop
    insert into public.automation_runs(owner_id,automation_id,scheduled_for,status,attempt_count,lease_expires_at) values(candidate.owner_id,candidate.id,candidate.next_run_at,'running',1,now()+interval '5 minutes')
      on conflict(automation_id,scheduled_for) do update set status='running',attempt_count=public.automation_runs.attempt_count+1,lease_expires_at=now()+interval '5 minutes',updated_at=now() returning * into claimed;
    update public.automations set next_run_at=null,last_run_at=claimed.scheduled_for,updated_at=now() where id=candidate.id;
    return next claimed;
  end loop;
end;
$$;

create or replace function public.claim_discord_automation_notifications(p_owner_id uuid,p_limit integer default 10)
returns setof public.discord_automation_notifications language sql set search_path=public as $$
 update public.discord_automation_notifications set status='delivering',attempt_count=attempt_count+1,lease_expires_at=now()+interval '2 minutes',updated_at=now()
 where id in (select id from public.discord_automation_notifications where owner_id=p_owner_id and ((status='pending' and next_attempt_at<=now()) or (status='delivering' and lease_expires_at<now())) order by created_at limit greatest(0,least(p_limit,25)) for update skip locked) returning *;
$$;

create or replace function public.claim_user_dreaming_run(p_owner_id uuid)
returns uuid language plpgsql set search_path=public as $$
declare v_run_id uuid; v_job_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,701));
  update public.dreaming_runs set status='queued',lease_expires_at=null,updated_at=now() where owner_id=p_owner_id and status='running' and lease_expires_at<now();
  select id into v_run_id from public.dreaming_runs where owner_id=p_owner_id and status='queued' order by created_at limit 1;
  if v_run_id is not null then return v_run_id; end if;
  select count(*) into v_job_count from (select completed.job_id from public.dreaming_completed_jobs completed where completed.owner_id=p_owner_id and not exists(select 1 from public.dreaming_run_sources source where source.owner_id=completed.owner_id and source.job_id=completed.job_id) order by completed.sequence limit 3) candidate;
  if v_job_count<3 then return null; end if;
  insert into public.dreaming_runs(owner_id,status) values(p_owner_id,'queued') returning id into v_run_id;
  insert into public.dreaming_run_sources(run_id,owner_id,job_id,sequence,conversation_id,completed_at)
    select v_run_id,completed.owner_id,completed.job_id,completed.sequence,completed.conversation_id,completed.completed_at from public.dreaming_completed_jobs completed where completed.owner_id=p_owner_id and not exists(select 1 from public.dreaming_run_sources source where source.owner_id=completed.owner_id and source.job_id=completed.job_id) order by completed.sequence limit 3;
  return v_run_id;
end;
$$;

create or replace function public.record_dreaming_cycle(p_owner_id uuid,p_run_id uuid)
returns integer language plpgsql set search_path=public as $$
declare v_count integer; v_cycle integer; v_run_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text,702));
  insert into public.user_memory_profiles(owner_id) values(p_owner_id) on conflict(owner_id) do nothing;
  insert into public.dreaming_cycle_runs(owner_id,run_id,cycle_number)
    select p_owner_id,p_run_id,profiles.dreaming_cycle_count+1 from public.user_memory_profiles profiles where profiles.owner_id=p_owner_id on conflict(owner_id,run_id) do nothing;
  if not found then return null; end if;
  update public.user_memory_profiles set dreaming_cycle_count=dreaming_cycle_count+1,updated_at=now() where owner_id=p_owner_id returning dreaming_cycle_count into v_count;
  if mod(v_count,5)<>0 then return null; end if;
  v_cycle:=v_count/5;
  select array_agg(cycle_runs.run_id order by cycle_runs.created_at) into v_run_ids from public.dreaming_cycle_runs cycle_runs where cycle_runs.owner_id=p_owner_id and cycle_runs.cycle_number=v_cycle;
  insert into public.dreaming_consolidations(owner_id,cycle_number,source_run_ids) values(p_owner_id,v_cycle,coalesce(v_run_ids,'{}'::uuid[])) on conflict(owner_id,cycle_number) do nothing;
  return v_cycle;
end;
$$;
