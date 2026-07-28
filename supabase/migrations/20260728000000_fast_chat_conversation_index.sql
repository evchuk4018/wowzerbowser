create or replace function public.list_chat_conversations_fast(
  p_owner_id uuid
)
returns table (
  conversation_id text,
  title text,
  updated_at timestamptz,
  has_messages boolean,
  is_streaming boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    conversations.conversation_id,
    conversations.title,
    conversations.updated_at,
    exists (
      select 1
      from public.chat_messages as messages
      where messages.owner_id = conversations.owner_id
        and messages.conversation_id = conversations.conversation_id
    ) as has_messages,
    exists (
      select 1
      from public.chat_messages as messages
      where messages.owner_id = conversations.owner_id
        and messages.conversation_id = conversations.conversation_id
        and messages.role = 'assistant'
        and messages.status = 'streaming'
    ) as is_streaming
  from public.chat_conversations as conversations
  where conversations.owner_id = p_owner_id
  order by conversations.updated_at desc;
$$;

create index if not exists chat_messages_streaming_conversation
  on public.chat_messages(owner_id, conversation_id)
  where role = 'assistant' and status = 'streaming';

revoke all on function public.list_chat_conversations_fast(uuid) from public, anon, authenticated;
grant execute on function public.list_chat_conversations_fast(uuid) to service_role;
