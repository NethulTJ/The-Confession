-- Keep customer transfer receipts private; the orders Edge Function uses the service role
-- to upload receipts and issue short-lived links to authenticated studio admins.
alter table public.orders add column if not exists payment_slip_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-slips', 'payment-slips', false, 5242880, array['image/jpeg','image/png','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','application/pdf'];

alter table public.orders enable row level security;
