alter table public.chat_job_events
  add column if not exists event_index bigint;

create or replace function public.assign_chat_job_event_index()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.event_index is null then
    select coalesce(max(events.event_index), 0) + 1
      into new.event_index
      from public.chat_job_events as events
      where events.owner_id = new.owner_id
        and events.conversation_id = new.conversation_id
        and events.job_id = new.job_id;
  end if;
  return new;
end;
$$;

drop trigger if exists assign_chat_job_event_index on public.chat_job_events;
create trigger assign_chat_job_event_index
before insert on public.chat_job_events
for each row execute function public.assign_chat_job_event_index();

with ranked_events as (
  select
    owner_id,
    conversation_id,
    job_id,
    sequence,
    row_number() over (
      partition by owner_id, conversation_id, job_id
      order by sequence
    ) as event_index
  from public.chat_job_events
)
update public.chat_job_events as events
set event_index = ranked_events.event_index
from ranked_events
where events.owner_id = ranked_events.owner_id
  and events.conversation_id = ranked_events.conversation_id
  and events.job_id = ranked_events.job_id
  and events.sequence = ranked_events.sequence
  and events.event_index is null;

update public.chat_messages as messages
set last_sequence = coalesce((
  select max(events.event_index)
  from public.chat_job_events as events
  where events.owner_id = messages.owner_id
    and events.conversation_id = messages.conversation_id
    and events.job_id = messages.job_id
    and events.sequence <= messages.last_sequence
), 0)
where messages.job_id is not null
  and messages.last_sequence > 0;

create or replace function public.translate_chat_message_event_checkpoint()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  translated_index bigint;
begin
  if new.job_id is not null
    and new.last_sequence > 0
    and (tg_op = 'INSERT' or new.last_sequence is distinct from old.last_sequence)
  then
    select events.event_index
      into translated_index
      from public.chat_job_events as events
      where events.owner_id = new.owner_id
        and events.conversation_id = new.conversation_id
        and events.job_id = new.job_id
        and events.sequence = new.last_sequence;
    if translated_index is not null then
      new.last_sequence = translated_index;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists translate_chat_message_event_checkpoint on public.chat_messages;
create trigger translate_chat_message_event_checkpoint
before insert or update of last_sequence on public.chat_messages
for each row execute function public.translate_chat_message_event_checkpoint();

alter table public.chat_job_events
  alter column event_index set not null;

create unique index if not exists chat_job_events_job_ordinal
  on public.chat_job_events(owner_id, conversation_id, job_id, event_index);
