-- DeepSeek bills reasoning tokens as part of total output tokens. The
-- adapter normalizes completion_tokens to visible output and keeps reasoning
-- as a separate breakdown, so both components use the output price.
update public.chat_model_pricing
   set reasoning_usd_per_million = output_usd_per_million,
       updated_at = clock_timestamp()
 where provider = 'deepseek'
   and model in ('deepseek-v4-flash', 'deepseek-v4-pro');

-- Repair usage captured before the adapter normalized DeepSeek's completion
-- breakdown. Existing completion_tokens included reasoning_tokens, so charge
-- the raw total once and then store the normalized visible-output count.
update public.chat_usage_records as records
   set completion_tokens = greatest(records.completion_tokens - records.reasoning_tokens, 0),
       cost_usd = (
         (records.prompt_tokens - least(records.prompt_tokens, records.cached_prompt_tokens)) * pricing.input_usd_per_million
         + least(records.prompt_tokens, records.cached_prompt_tokens) * coalesce(pricing.cached_input_usd_per_million, pricing.input_usd_per_million)
         + records.completion_tokens * pricing.output_usd_per_million
       ) / 1000000 + coalesce(pricing.request_usd, 0),
       input_usd_per_million = pricing.input_usd_per_million,
       cached_input_usd_per_million = pricing.cached_input_usd_per_million,
       output_usd_per_million = pricing.output_usd_per_million,
       request_usd = pricing.request_usd,
       reasoning_usd_per_million = pricing.output_usd_per_million,
       pricing_label = pricing.label,
       pricing_snapshot = jsonb_build_object(
         'provider', pricing.provider,
         'model', pricing.model,
         'label', pricing.label,
         'inputUsdPerMillion', pricing.input_usd_per_million,
         'cachedInputUsdPerMillion', pricing.cached_input_usd_per_million,
         'outputUsdPerMillion', pricing.output_usd_per_million,
         'requestUsd', pricing.request_usd,
         'reasoningUsdPerMillion', pricing.output_usd_per_million
       ),
       unpriced = false
  from public.chat_model_pricing as pricing
 where records.provider = pricing.provider
   and records.model = pricing.model
   and records.provider = 'deepseek'
   and records.model in ('deepseek-v4-flash', 'deepseek-v4-pro')
   and records.reasoning_tokens > 0
   and records.exact_cost_usd is null;

update public.chat_usage_outbox as outbox
   set completion_tokens = greatest(outbox.completion_tokens - outbox.reasoning_tokens, 0),
       pricing_snapshot = jsonb_build_object(
         'provider', pricing.provider,
         'model', pricing.model,
         'label', pricing.label,
         'inputUsdPerMillion', pricing.input_usd_per_million,
         'cachedInputUsdPerMillion', pricing.cached_input_usd_per_million,
         'outputUsdPerMillion', pricing.output_usd_per_million,
         'requestUsd', pricing.request_usd,
         'reasoningUsdPerMillion', pricing.output_usd_per_million
       ),
       unpriced = false
  from public.chat_model_pricing as pricing
 where outbox.provider = pricing.provider
   and outbox.model = pricing.model
   and outbox.provider = 'deepseek'
   and outbox.model in ('deepseek-v4-flash', 'deepseek-v4-pro')
   and outbox.reasoning_tokens > 0;

do $$
declare
  affected record;
begin
  for affected in
    select distinct owner_id, conversation_id, job_id
      from public.chat_usage_records
     where provider = 'deepseek'
       and model in ('deepseek-v4-flash', 'deepseek-v4-pro')
       and reasoning_tokens > 0
       and conversation_id is not null
       and job_id is not null
  loop
    perform public.refresh_chat_job_cost(affected.owner_id, affected.conversation_id, affected.job_id);
  end loop;
end;
$$;
