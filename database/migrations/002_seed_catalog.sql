insert into public.chat_model_pricing (
  provider, model, label, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million
)
values
  ('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 0.14, 0.0028, 0.28),
  ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 0.435, 0.003625, 0.87)
on conflict (provider, model) do nothing;
