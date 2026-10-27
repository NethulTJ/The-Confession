-- Order workflow for Secret Flower Studio.
-- Apply with: supabase db push (or paste into the Supabase SQL editor).
create extension if not exists pgcrypto;

do $$ begin
  create type public.order_status as enum ('pending','confirmed','preparing','ready','fulfilled','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.order_number_counters (
  order_date date primary key,
  last_number integer not null
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  client_request_id uuid not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  recipient_name text not null,
  recipient_phone text not null,
  delivery_address text,
  delivery_city text,
  delivery_postal_code text,
  delivery_instructions text,
  subtotal integer not null check (subtotal >= 0),
  currency char(3) not null default 'LKR' check (currency = 'LKR'),
  status public.order_status not null default 'pending',
  confirmation_email_status text not null default 'pending' check (confirmation_email_status in ('pending','sent','failed')),
  confirmation_email_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upgrade legacy orders in place; old JSON remains available until item snapshots are backfilled.
alter table public.orders add column if not exists order_number text;
alter table public.orders add column if not exists client_request_id uuid;
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_email text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists recipient_name text;
alter table public.orders add column if not exists recipient_phone text;
alter table public.orders add column if not exists delivery_address text;
alter table public.orders add column if not exists delivery_city text;
alter table public.orders add column if not exists delivery_postal_code text;
alter table public.orders add column if not exists delivery_instructions text;
alter table public.orders add column if not exists currency char(3) not null default 'LKR';
alter table public.orders add column if not exists confirmation_email_status text not null default 'pending';
alter table public.orders add column if not exists confirmation_email_error text;
alter table public.orders add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='items') then
    alter table public.orders alter column items drop not null;
  end if;
end $$;

-- Existing anonymous inserts had no customer details, so keep legacy rows readable only to admins.
update public.orders set
  order_number = coalesce(order_number, 'SC-LEGACY-' || upper(substr(id::text,1,8))),
  client_request_id = coalesce(client_request_id, gen_random_uuid()),
  customer_name = coalesce(customer_name, 'Legacy order'),
  customer_email = coalesce(customer_email, 'legacy@invalid.local'),
  customer_phone = coalesce(customer_phone, 'not provided'),
  recipient_name = coalesce(nullif(trim(recipient_name), ''), customer_name, 'Legacy order'),
  recipient_phone = coalesce(nullif(trim(recipient_phone), ''), customer_phone, 'not provided'),
  delivery_address = coalesce(delivery_address, 'Not provided'),
  delivery_city = coalesce(delivery_city, 'Not provided')
where order_number is null or client_request_id is null or customer_name is null or recipient_name is null or recipient_phone is null;
alter table public.orders alter column order_number set not null;
alter table public.orders alter column client_request_id set not null;
alter table public.orders alter column customer_name set not null;
alter table public.orders alter column customer_email set not null;
alter table public.orders alter column customer_phone set not null;
alter table public.orders alter column recipient_name set not null;
alter table public.orders alter column recipient_phone set not null;
create unique index if not exists orders_client_request_id_key on public.orders(client_request_id);
create unique index if not exists orders_order_number_key on public.orders(order_number);

-- Replace the old text status constraint with the shared status enum.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.orders'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.orders drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.orders alter column status drop default;
alter table public.orders alter column status type public.order_status using
  (case when status::text in ('new','new order') then 'pending'
        when status::text in ('delivered','complete','completed') then 'fulfilled'
        when status::text in ('pending','confirmed','preparing','ready','fulfilled','cancelled') then status::text
        else 'pending' end)::public.order_status;
alter table public.orders alter column status set default 'pending';

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  flower_id text not null check (flower_id in ('chrysanthemum','lilies','rose')),
  flower_name text not null,
  stem_quantity integer not null check (stem_quantity > 0),
  selected_colors jsonb not null default '[]'::jsonb,
  wrap_name text not null,
  unit_price integer not null check (unit_price >= 0),
  item_subtotal integer not null check (item_subtotal >= 0),
  created_at timestamptz not null default now()
);
create table if not exists public.order_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  note_text text not null,
  note_type text not null check (note_type in ('included','extra')),
  price integer not null default 0 check (price >= 0),
  created_at timestamptz not null default now()
);
create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists order_notes_order_id_idx on public.order_notes(order_id);

-- Preserve snapshots from the old JSON items column for existing storefront orders.
do $$ declare
  v_order record; v_item jsonb; v_note jsonb; v_item_id uuid; v_extra integer; v_price integer; v_qty integer; v_note_index integer; v_included_count integer;
begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='items') then
    for v_order in execute 'select o.id, o.items from public.orders o where jsonb_typeof(o.items)=''array'' and not exists(select 1 from public.order_items i where i.order_id=o.id)' loop
      for v_item in select value from jsonb_array_elements(v_order.items) loop
        if v_item->>'id' not in ('chrysanthemum','lilies','rose') then continue; end if;
        v_qty:=greatest(1,coalesce((v_item->>'stems')::integer,1));
        v_extra:=greatest(0,coalesce((v_item->>'extraNoteCount')::integer,0));
        v_price:=greatest(0,coalesce((v_item->>'price')::integer,0));
        insert into public.order_items(order_id,flower_id,flower_name,stem_quantity,selected_colors,wrap_name,unit_price,item_subtotal)
        values(v_order.id,v_item->>'id',coalesce(v_item->>'name',initcap(v_item->>'id')),v_qty,coalesce(v_item->'stemColors','[]'::jsonb),coalesce(v_item->>'wrap','Oat'),greatest(0,v_price-v_extra*100),v_price)
        returning id into v_item_id;
        v_included_count:=greatest(0,jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))-v_extra);
        for v_note,v_note_index in select value,ord::integer from jsonb_array_elements(coalesce(v_item->'messages','[]'::jsonb)) with ordinality as n(value,ord) loop
          insert into public.order_notes(order_id,order_item_id,note_text,note_type,price)
          values(v_order.id,v_item_id,v_note#>>'{}',case when v_note_index<=v_included_count then 'included' else 'extra' end,case when v_note_index<=v_included_count then 0 else 100 end);
        end loop;
      end loop;
    end loop;
  end if;
end $$;

do $$ declare p record; begin
  for p in select schemaname, tablename, policyname from pg_policies
    where schemaname='public' and tablename in ('orders','order_items','order_notes','order_number_counters')
  loop execute format('drop policy %I on %I.%I',p.policyname,p.schemaname,p.tablename); end loop;
end $$;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_notes enable row level security;
alter table public.order_number_counters enable row level security;
create policy "Admins can read orders" on public.orders for select to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin');
create policy "Admins can update orders" on public.orders for update to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin')
  with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');
create policy "Admins can read order items" on public.order_items for select to authenticated
  using (exists(select 1 from public.orders o where o.id=order_id and (auth.jwt()->'app_metadata'->>'role')='admin'));
create policy "Admins can read order notes" on public.order_notes for select to authenticated
  using (exists(select 1 from public.orders o where o.id=order_id and (auth.jwt()->'app_metadata'->>'role')='admin'));
revoke all on public.orders, public.order_items, public.order_notes, public.order_number_counters from anon, authenticated;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_confirmation_email_status_check') then
    alter table public.orders add constraint orders_confirmation_email_status_check check (confirmation_email_status in ('pending','sent','failed'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_currency_check') then
    alter table public.orders add constraint orders_currency_check check (currency='LKR');
  end if;
end $$;
grant select, update on public.orders to authenticated;
grant select on public.order_items, public.order_notes to authenticated;

-- Single transaction: per-day row locking allocates collision-safe sequence numbers and inserts
-- the order, immutable item snapshots, and notes together. Only the server service role may call it.
create or replace function public.create_flower_order(p_order jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_date date := (now() at time zone 'Asia/Colombo')::date;
  v_next integer;
  v_id uuid := gen_random_uuid();
  v_order_number text;
  v_item jsonb;
  v_note jsonb;
  v_item_id uuid;
  v_name text;
  v_qty integer;
  v_base integer;
  v_expected integer;
  v_subtotal integer := 0;
  v_item_sum integer;
  v_notes_sum integer;
begin
  if coalesce(nullif(trim(p_order->>'recipient_name'), ''), nullif(trim(p_order->>'customer_name'), '')) is null or length(coalesce(nullif(trim(p_order->>'recipient_name'), ''), trim(p_order->>'customer_name'))) > 100 or coalesce(nullif(p_order->>'recipient_phone',''), p_order->>'customer_phone', '') !~ '^[+0-9() -]{7,20}$' then
    raise exception 'Recipient name and phone are required';
  end if;
  if jsonb_typeof(p_order->'items') <> 'array' or jsonb_array_length(p_order->'items') not between 1 and 20 then
    raise exception 'Order must contain between 1 and 20 items';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order->>'client_request_id',0));
  if exists(select 1 from public.orders where client_request_id=(p_order->>'client_request_id')::uuid) then
    return (select jsonb_build_object('id',id,'order_number',order_number,'subtotal',subtotal,'confirmation_email_status',confirmation_email_status,'existing',true) from public.orders where client_request_id=(p_order->>'client_request_id')::uuid);
  end if;
  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    v_qty := (v_item->>'stems')::integer;
    if v_item->>'flower_id'='chrysanthemum' then v_name:='Chrysanthemum'; v_base:=case v_qty when 1 then 400 when 2 then 750 when 3 then 990 when 4 then 1250 else -1 end;
    elsif v_item->>'flower_id'='lilies' then v_name:='Lilies'; v_base:=case v_qty when 1 then 950 when 2 then 1600 when 3 then 2200 when 4 then 2900 else -1 end;
    elsif v_item->>'flower_id'='rose' then v_name:='Rose'; v_base:=case v_qty when 1 then 450 else -1 end;
    else raise exception 'Unknown flower'; end if;
    if v_base < 0 then raise exception 'Invalid stem quantity'; end if;
    if jsonb_array_length(coalesce(v_item->'stemColors','[]'::jsonb))<>v_qty then raise exception 'Each stem needs a selected color'; end if;
    if coalesce((v_item->>'extraNoteCount')::integer,0) not between 0 and 10 then raise exception 'Invalid extra note count'; end if;
    if jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb)) not in (coalesce((v_item->>'extraNoteCount')::integer,0),coalesce((v_item->>'extraNoteCount')::integer,0)+1) then raise exception 'Invalid note count'; end if;
    v_notes_sum:=coalesce((v_item->>'extraNoteCount')::integer,0);
    for v_note in select value from jsonb_array_elements(coalesce(v_item->'messages','[]'::jsonb)) loop
      if length(trim(v_note#>>'{}'))=0 or length(v_note#>>'{}')>1600 then raise exception 'Invalid note'; end if;
    end loop;
    v_expected:=v_base+v_notes_sum*100;
    v_subtotal:=v_subtotal+v_expected;
  end loop;
  insert into public.order_number_counters(order_date,last_number) values(v_date,1)
    on conflict(order_date) do update set last_number=order_number_counters.last_number+1 returning last_number into v_next;
  v_order_number:='SC-'||to_char(v_date,'YYYYMMDD')||'-'||lpad(v_next::text,3,'0');
  insert into public.orders(id,order_number,client_request_id,customer_name,customer_email,customer_phone,recipient_name,recipient_phone,subtotal)
  values(v_id,v_order_number,(p_order->>'client_request_id')::uuid,trim(p_order->>'customer_name'),lower(trim(p_order->>'customer_email')),trim(p_order->>'customer_phone'),coalesce(nullif(trim(p_order->>'recipient_name'),''),trim(p_order->>'customer_name')),coalesce(nullif(trim(p_order->>'recipient_phone'),''),trim(p_order->>'customer_phone')),v_subtotal);
  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    v_qty:=(v_item->>'stems')::integer;
    if v_item->>'flower_id'='chrysanthemum' then v_name:='Chrysanthemum'; v_base:=case v_qty when 1 then 400 when 2 then 750 when 3 then 990 when 4 then 1250 end;
    elsif v_item->>'flower_id'='lilies' then v_name:='Lilies'; v_base:=case v_qty when 1 then 950 when 2 then 1600 when 3 then 2200 when 4 then 2900 end;
    else v_name:='Rose'; v_base:=450; end if;
    v_notes_sum:=coalesce((v_item->>'extraNoteCount')::integer,0);
    v_item_sum:=v_base+v_notes_sum*100;
    insert into public.order_items(order_id,flower_id,flower_name,stem_quantity,selected_colors,wrap_name,unit_price,item_subtotal)
    values(v_id,v_item->>'flower_id',v_name,v_qty,coalesce(v_item->'stemColors','[]'::jsonb),coalesce(v_item->>'wrap','Oat'),v_base,v_item_sum) returning id into v_item_id;
    for v_note,v_expected in select value, ordinality::integer from jsonb_array_elements(coalesce(v_item->'messages','[]'::jsonb)) with ordinality loop
      insert into public.order_notes(order_id,order_item_id,note_text,note_type,price)
      values(v_id,v_item_id,v_note#>>'{}',case when v_expected <= jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))-v_notes_sum then 'included' else 'extra' end,case when v_expected <= jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))-v_notes_sum then 0 else 100 end);
    end loop;
  end loop;
  return jsonb_build_object('id',v_id,'order_number',v_order_number,'subtotal',v_subtotal,'confirmation_email_status','pending','existing',false);
end $$;
revoke all on function public.create_flower_order(jsonb) from public, anon, authenticated;
grant execute on function public.create_flower_order(jsonb) to service_role;
