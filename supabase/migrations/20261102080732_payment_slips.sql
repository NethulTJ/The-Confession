-- Private storage for customer transfer slips.
alter table public.orders
  add column if not exists payment_slip_path text;

insert into storage.buckets (id, name, public)
values ('payment-slips', 'payment-slips', false)
on conflict (id) do update set public = false;
