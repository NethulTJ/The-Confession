create table if not exists public.shop_settings (
  id integer primary key check (id = 1),
  accepting_orders boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.shop_settings (id, accepting_orders)
values (1, true)
on conflict (id) do nothing;

alter table public.shop_settings enable row level security;

grant select, update on public.shop_settings to service_role;
