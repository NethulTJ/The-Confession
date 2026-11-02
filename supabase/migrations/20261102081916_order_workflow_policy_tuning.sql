-- Keep service-only sequence counters behind an explicit policy and help the
-- admin RLS predicates scale without recalculating JWT claims for each row.
create policy "Service role manages counters"
  on public.order_number_counters for all to service_role
  using (true) with check (true);

drop policy if exists "Admins can read orders" on public.orders;
create policy "Admins can read orders" on public.orders for select to authenticated
  using (((select auth.jwt())->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admins can update orders" on public.orders;
create policy "Admins can update orders" on public.orders for update to authenticated
  using (((select auth.jwt())->'app_metadata'->>'role') = 'admin')
  with check (((select auth.jwt())->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admins can read order items" on public.order_items;
create policy "Admins can read order items" on public.order_items for select to authenticated
  using (exists(select 1 from public.orders o where o.id=order_id and ((select auth.jwt())->'app_metadata'->>'role')='admin'));

drop policy if exists "Admins can read order notes" on public.order_notes;
create policy "Admins can read order notes" on public.order_notes for select to authenticated
  using (exists(select 1 from public.orders o where o.id=order_id and ((select auth.jwt())->'app_metadata'->>'role')='admin'));

create index if not exists order_notes_order_item_id_idx on public.order_notes(order_item_id);
