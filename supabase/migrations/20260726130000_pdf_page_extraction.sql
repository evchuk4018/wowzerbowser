alter table public.chat_document_pages
  add column if not exists extraction_method text;

update public.chat_document_pages
set extraction_method = case
  when btrim(text) = '' then 'blank'
  else coalesce(nullif(extraction_method, ''), 'native')
end
where extraction_method is null or (extraction_method = 'native' and btrim(text) = '');

alter table public.chat_document_pages
  alter column extraction_method set default 'native',
  alter column extraction_method set not null;

alter table public.chat_document_pages
  drop constraint if exists chat_document_pages_extraction_method_check;

alter table public.chat_document_pages
  add constraint chat_document_pages_extraction_method_check
  check (extraction_method in ('native', 'ocr', 'blank'));

alter table public.chat_document_pages
  add column if not exists failure jsonb;
