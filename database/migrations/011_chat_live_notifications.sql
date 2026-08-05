-- Live chat delivery uses notifications only as a wake-up hint. The event
-- table remains the authoritative ordered log used for replay and recovery.

create or replace function public.notify_chat_job_event()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_notify(
    'wowzerbowser_chat_events',
    jsonb_build_object(
      'ownerId', new.owner_id::text,
      'conversationId', new.conversation_id,
      'jobId', new.job_id
    )::text
  );
  return new;
end;
$$;

drop trigger if exists notify_chat_job_event on public.chat_job_events;
create trigger notify_chat_job_event
after insert on public.chat_job_events
for each row execute function public.notify_chat_job_event();
