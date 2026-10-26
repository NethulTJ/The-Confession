create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  items jsonb not null,
  subtotal integer not null check (subtotal >= 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

-- Storefront visitors may submit orders. Reading and changing orders requires a privileged server role.
create policy "Allow public order submission"
  on public.orders
  for insert
  to anon
  with check (true);
