create or replace function public.search_chat_conversations(
  p_owner_id uuid,
  p_query text
)
returns table (
  conversation_id text,
  title text,
  updated_at timestamptz,
  preview text
)
language sql
stable
security definer
set search_path = public
as $$
  with conversation_text as (
    select
      conversations.conversation_id,
      conversations.title,
      conversations.updated_at,
      summaries.summary,
      coalesce(
        nullif(summaries.summary, ''),
        (
          select messages.content
          from public.chat_messages as messages
          where messages.owner_id = conversations.owner_id
            and messages.conversation_id = conversations.conversation_id
            and messages.content <> ''
          order by messages.updated_at desc
          limit 1
        ),
        ''
      ) as preview,
      lower(conversations.title || ' ' || coalesce(summaries.summary, '') || ' ' || coalesce(messages.searchable_content, '')) as searchable_text
    from public.chat_conversations as conversations
    left join public.chat_conversation_summaries as summaries
      on summaries.owner_id = conversations.owner_id
      and summaries.conversation_id = conversations.conversation_id
    left join lateral (
      select string_agg(messages.content, ' ') as searchable_content
      from public.chat_messages as messages
      where messages.owner_id = conversations.owner_id
        and messages.conversation_id = conversations.conversation_id
    ) as messages on true
    where conversations.owner_id = p_owner_id
  )
  select
    conversation_text.conversation_id,
    conversation_text.title,
    conversation_text.updated_at,
    left(conversation_text.preview, 240)
  from conversation_text
  where nullif(trim(p_query), '') is null
    or not exists (
      select 1
      from regexp_split_to_table(lower(trim(p_query)), '\s+') as term
      where term <> ''
        and conversation_text.searchable_text not like '%' || term || '%'
    )
  order by conversation_text.updated_at desc;
$$;

revoke all on function public.search_chat_conversations(uuid, text) from public, anon, authenticated;
grant execute on function public.search_chat_conversations(uuid, text) to service_role;
