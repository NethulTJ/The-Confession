alter table public.order_items drop constraint if exists order_items_flower_id_check;
alter table public.order_items add constraint order_items_flower_id_check check (flower_id in (
  'chrysanthemum','lilies','rose',
  'bouquet-golden-hour','bouquet-blushing-snow','bouquet-sunset-glow','bouquet-honey-blush',
  'bouquet-lavender-kiss','bouquet-pink-whisper','bouquet-summer-kiss','bouquet-berry-bloom',
  'bouquet-ivory-dream','bouquet-coral-charm','bouquet-spring-glow','bouquet-sweet-peony','bouquet-rose-dreams','bouquet-pastel-harmony','bouquet-pure-elegance','bouquet-red-velvet','bouquet-springtime-glow','rose-red-stem','rose-white-stem','wax-sachets'
));

create or replace function public.create_flower_order(p_order jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_date date := (now() at time zone 'Asia/Colombo')::date;
  v_next integer; v_id uuid := gen_random_uuid(); v_order_number text;
  v_item jsonb; v_note jsonb; v_item_id uuid; v_name text;
  v_qty integer; v_base integer; v_expected integer; v_subtotal integer := 0;
  v_item_sum integer; v_notes_sum integer; v_flower_id text;
begin
  if coalesce((p_order->>'terms_accepted')::boolean,false) is not true or nullif(p_order->>'terms_accepted_at','') is null then raise exception 'Delivery terms must be accepted before placing an order'; end if;
  if coalesce(nullif(trim(p_order->>'recipient_name'),''),nullif(trim(p_order->>'customer_name'),'')) is null or length(coalesce(nullif(trim(p_order->>'recipient_name'),''),trim(p_order->>'customer_name'))) > 100 or coalesce(nullif(p_order->>'recipient_phone',''),p_order->>'customer_phone','') !~ '^[+0-9() -]{7,20}$' then raise exception 'Recipient name and phone are required'; end if;
  if jsonb_typeof(p_order->'items') <> 'array' or jsonb_array_length(p_order->'items') not between 1 and 20 then raise exception 'Order must contain between 1 and 20 items'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order->>'client_request_id',0));
  if exists(select 1 from public.orders where client_request_id=(p_order->>'client_request_id')::uuid) then return (select jsonb_build_object('id',id,'order_number',order_number,'subtotal',subtotal,'confirmation_email_status',confirmation_email_status,'existing',true) from public.orders where client_request_id=(p_order->>'client_request_id')::uuid); end if;

  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    v_flower_id:=v_item->>'flower_id'; v_qty:=(v_item->>'stems')::integer;
    if v_flower_id='chrysanthemum' then v_base:=case v_qty when 1 then 400 when 2 then 750 when 3 then 990 when 4 then 1250 else -1 end;
    elsif v_flower_id='lilies' then v_base:=case v_qty when 1 then 950 when 2 then 1600 when 3 then 2200 when 4 then 2900 else -1 end;
    elsif v_flower_id='rose' then v_base:=case v_qty when 1 then 450 else -1 end;
    elsif v_flower_id='wax-sachets' then v_base:=case v_qty when 1 then 450 else -1 end;
    else v_base:=case v_flower_id when 'bouquet-golden-hour' then 3000 when 'bouquet-blushing-snow' then 5500 when 'bouquet-sunset-glow' then 4500 when 'bouquet-honey-blush' then 3500 when 'bouquet-lavender-kiss' then 2500 when 'bouquet-pink-whisper' then 2000 when 'bouquet-summer-kiss' then 2000 when 'bouquet-berry-bloom' then 2000 when 'bouquet-ivory-dream' then 2300 when 'bouquet-coral-charm' then 2000 when 'bouquet-spring-glow' then 2100 when 'bouquet-sweet-peony' then 6000 when 'bouquet-rose-dreams' then 3200 when 'bouquet-pastel-harmony' then 3600 when 'bouquet-pure-elegance' then 2500 when 'bouquet-red-velvet' then 6000 when 'bouquet-springtime-glow' then 3000 when 'rose-red-stem' then 450 when 'rose-white-stem' then 450 else -1 end;
    end if;
    if v_base < 0 then raise exception 'Unknown flower or invalid stem quantity'; end if;
    if v_flower_id in ('chrysanthemum','lilies','rose') and jsonb_array_length(coalesce(v_item->'stemColors','[]'::jsonb))<>v_qty then raise exception 'Each stem needs a selected color'; end if;
    if v_flower_id='wax-sachets' and (jsonb_array_length(coalesce(v_item->'stemColors','[]'::jsonb))<>1 or v_item->'stemColors'->>0 not in ('Cinnamon','Lavender','Vanilla','Coffee','Floral') or coalesce((v_item->>'extraNoteCount')::integer,0)<>0 or jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))<>0) then raise exception 'Invalid wax sachet selection'; end if;
    if v_flower_id not in ('chrysanthemum','lilies','rose','wax-sachets') and (v_qty<>1 or jsonb_array_length(coalesce(v_item->'stemColors','[]'::jsonb))<>0 or coalesce((v_item->>'extraNoteCount')::integer,0)<>0 or jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))<>0) then raise exception 'Invalid ready-made bouquet'; end if;
    if coalesce((v_item->>'extraNoteCount')::integer,0) not between 0 and 10 then raise exception 'Invalid extra note count'; end if;
    if jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb)) not in (coalesce((v_item->>'extraNoteCount')::integer,0),coalesce((v_item->>'extraNoteCount')::integer,0)+1) then raise exception 'Invalid note count'; end if;
    v_notes_sum:=coalesce((v_item->>'extraNoteCount')::integer,0);
    for v_note in select value from jsonb_array_elements(coalesce(v_item->'messages','[]'::jsonb)) loop if length(trim(v_note#>>'{}'))=0 or length(v_note#>>'{}')>1600 then raise exception 'Invalid note'; end if; end loop;
    v_subtotal:=v_subtotal+v_base+v_notes_sum*100;
  end loop;

  insert into public.order_number_counters(order_date,last_number) values(v_date,1) on conflict(order_date) do update set last_number=order_number_counters.last_number+1 returning last_number into v_next;
  v_order_number:='SC-'||to_char(v_date,'YYYYMMDD')||'-'||lpad(v_next::text,3,'0');
  insert into public.orders(id,order_number,client_request_id,customer_name,customer_email,customer_phone,recipient_name,recipient_phone,subtotal,terms_accepted_at)
  values(v_id,v_order_number,(p_order->>'client_request_id')::uuid,trim(p_order->>'customer_name'),lower(trim(p_order->>'customer_email')),trim(p_order->>'customer_phone'),coalesce(nullif(trim(p_order->>'recipient_name'),''),trim(p_order->>'customer_name')),coalesce(nullif(trim(p_order->>'recipient_phone'),''),trim(p_order->>'customer_phone')),v_subtotal,(p_order->>'terms_accepted_at')::timestamptz);
  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    v_flower_id:=v_item->>'flower_id'; v_qty:=(v_item->>'stems')::integer;
    if v_flower_id='chrysanthemum' then v_name:='Chrysanthemum'; v_base:=case v_qty when 1 then 400 when 2 then 750 when 3 then 990 when 4 then 1250 end;
    elsif v_flower_id='lilies' then v_name:='Lilies'; v_base:=case v_qty when 1 then 950 when 2 then 1600 when 3 then 2200 when 4 then 2900 end;
    elsif v_flower_id='rose' then v_name:='Rose'; v_base:=450;
    elsif v_flower_id='wax-sachets' then v_name:='Wax sachets'; v_base:=450;
    elsif v_flower_id like 'bouquet-%' then
      v_name:=case v_flower_id
        when 'bouquet-golden-hour' then 'Golden hour' when 'bouquet-blushing-snow' then 'Blushing snow'
        when 'bouquet-sunset-glow' then 'Sunset glow' when 'bouquet-honey-blush' then 'Honey blush'
        when 'bouquet-lavender-kiss' then 'Lavender kiss' when 'bouquet-pink-whisper' then 'Pink whisper'
        when 'bouquet-summer-kiss' then 'Summer kiss' when 'bouquet-berry-bloom' then 'Berry bloom'
        when 'bouquet-ivory-dream' then 'Ivory dream' when 'bouquet-coral-charm' then 'Coral charm'
        when 'bouquet-spring-glow' then 'Spring glow' when 'bouquet-sweet-peony' then 'Sweet Peony' when 'bouquet-rose-dreams' then 'Rosè Dreams' when 'bouquet-pastel-harmony' then 'Pastel Harmony' when 'bouquet-pure-elegance' then 'Pure Elegance' when 'bouquet-red-velvet' then 'Red Velvet' when 'bouquet-springtime-glow' then 'Springtime Glow' end;
      v_base:=case v_flower_id when 'bouquet-golden-hour' then 3000 when 'bouquet-blushing-snow' then 5500 when 'bouquet-sunset-glow' then 4500 when 'bouquet-honey-blush' then 3500 when 'bouquet-lavender-kiss' then 2500 when 'bouquet-pink-whisper' then 2000 when 'bouquet-summer-kiss' then 2000 when 'bouquet-berry-bloom' then 2000 when 'bouquet-ivory-dream' then 2300 when 'bouquet-coral-charm' then 2000 when 'bouquet-spring-glow' then 2100 when 'bouquet-sweet-peony' then 6000 when 'bouquet-rose-dreams' then 3200 when 'bouquet-pastel-harmony' then 3600 when 'bouquet-pure-elegance' then 2500 when 'bouquet-red-velvet' then 6000 when 'bouquet-springtime-glow' then 3000 end;
    else
      v_name:=case v_flower_id when 'rose-red-stem' then 'Red rose stem' when 'rose-white-stem' then 'White rose stem' end;
      v_base:=450;
    end if;
    v_notes_sum:=coalesce((v_item->>'extraNoteCount')::integer,0); v_item_sum:=v_base+v_notes_sum*100;
    insert into public.order_items(order_id,flower_id,flower_name,stem_quantity,selected_colors,wrap_name,unit_price,item_subtotal)
    values(v_id,v_flower_id,v_name,v_qty,coalesce(v_item->'stemColors','[]'::jsonb),coalesce(v_item->>'wrap','As pictured'),v_base,v_item_sum) returning id into v_item_id;
    for v_note,v_expected in select value,ordinality::integer from jsonb_array_elements(coalesce(v_item->'messages','[]'::jsonb)) with ordinality loop
      insert into public.order_notes(order_id,order_item_id,note_text,note_type,price) values(v_id,v_item_id,v_note#>>'{}',case when v_expected<=jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))-v_notes_sum then 'included' else 'extra' end,case when v_expected<=jsonb_array_length(coalesce(v_item->'messages','[]'::jsonb))-v_notes_sum then 0 else 100 end);
    end loop;
  end loop;
  return jsonb_build_object('id',v_id,'order_number',v_order_number,'subtotal',v_subtotal,'confirmation_email_status','pending','terms_accepted_at',p_order->>'terms_accepted_at','existing',false);
end $$;
revoke all on function public.create_flower_order(jsonb) from public,anon,authenticated;
grant execute on function public.create_flower_order(jsonb) to service_role;
