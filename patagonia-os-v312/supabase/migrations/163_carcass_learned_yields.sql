-- 163: Despiece aprende de lo pesado de verdad (2026-10-27, pedido del dueño: "una media de 100 kg no rinde igual que
-- una de 130; si uno tiene 4 promedios, que sea más exacto").
--
-- No se elige nada. Al repartir una res, si el negocio tiene al menos 2 reses PESADAS de verdad del mismo animal y de
-- peso parecido (±12 %), se reparte con el promedio de esas (las 8 más nuevas); si no, con los cortes de siempre.
-- - "Pesada de verdad" = tiene cortes, ninguno quedó como lo repartió el sistema (carcass_cuts.from_template = false:
--   cargados a mano o corregidos) y suman al menos la mitad del peso (descarta despostes a medio cargar).
--   "Listo, la pesé" (mark_carcass_batch_weighed) marca todos los cortes de una res como pesados.
-- - Promedio = kilos de cada corte sumados ÷ kilos de las reses sumados (las pesadas pesan más en el promedio).
--   Los cortes que nunca tuvieron precio (hueso, grasa) no se reparten: quedan como merma.
-- - El producto y el precio salen de la res pesada más nueva; si el corte tiene producto, el precio es el de Stock hoy.
-- - carcass_batches.fill_source dice de dónde salió el reparto, para mostrarlo: {"kind":"learned","batches":4,
--   "min":118,"max":127} o {"kind":"template"}.
-- - fill_carcass_batch: repartir desde la pantalla (antes lo hacía el navegador corte por corte), con la misma cuenta.

alter table public.carcass_batches add column if not exists fill_source jsonb;

create or replace function public.carcass_fill_from_template(p_batch_id uuid, p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_batch public.carcass_batches%rowtype;
  v_key text;
  v_sum numeric;
  t record;
  v_weight numeric;
  v_cut_id uuid;
  v_movement_id uuid;
  v_count int := 0;
  v_ids uuid[];
  v_n int;
  v_min numeric;
  v_max numeric;
  v_total numeric;
begin
  select * into v_batch from public.carcass_batches where id = p_batch_id;
  if v_batch.id is null or v_batch.total_weight <= 0 then
    return 0;
  end if;
  if exists (select 1 from public.carcass_cuts where batch_id = p_batch_id) then
    return 0;
  end if;
  v_key := public.carcass_type_key(v_batch.animal_type);

  -- 1. Reses pesadas de verdad, del mismo animal y peso parecido.
  select coalesce(array_agg(s.id), '{}'), count(*), min(s.total_weight), max(s.total_weight), coalesce(sum(s.total_weight), 0)
  into v_ids, v_n, v_min, v_max, v_total
  from (
    select b.id, b.total_weight
    from public.carcass_batches b
    where b.company_id = v_batch.company_id
      and b.id <> p_batch_id
      and public.carcass_type_key(b.animal_type) = v_key
      and b.total_weight between v_batch.total_weight * 0.88 and v_batch.total_weight * 1.12
      and exists (select 1 from public.carcass_cuts c where c.batch_id = b.id)
      and not exists (select 1 from public.carcass_cuts c where c.batch_id = b.id and c.from_template)
      and (select sum(c.weight) from public.carcass_cuts c where c.batch_id = b.id) >= b.total_weight * 0.5
    order by b.batch_date desc, b.created_at desc
    limit 8
  ) s;

  if v_n >= 2 and v_total > 0 then
    for t in
      select x.cut_name, x.pct, x.product_id, coalesce(p.price_retail, x.last_price) as price,
             case when p.id is not null then x.product_id end as stock_product_id
      from (
        select (array_agg(trim(c.cut_name) order by b.batch_date desc, b.created_at desc))[1] as cut_name,
               sum(c.weight) / v_total * 100 as pct,
               (array_agg(c.product_id order by b.batch_date desc, b.created_at desc) filter (where c.product_id is not null))[1] as product_id,
               (array_agg(c.unit_price order by b.batch_date desc, b.created_at desc) filter (where c.unit_price > 0))[1] as last_price,
               sum(c.weight) as total_kg
        from public.carcass_cuts c
        join public.carcass_batches b on b.id = c.batch_id
        where c.batch_id = any(v_ids)
        group by public.carcass_norm(c.cut_name)
        having max(c.unit_price) > 0
      ) x
      left join public.products p on p.id = x.product_id and p.company_id = v_batch.company_id
      order by x.total_kg desc
    loop
      v_weight := round(v_batch.total_weight * (t.pct / 100), 3);
      continue when v_weight <= 0;
      v_cut_id := gen_random_uuid();
      v_movement_id := null;
      if t.stock_product_id is not null then
        insert into public.inventory_movements (
          company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by
        ) values (
          v_batch.company_id, v_batch.branch_id, t.stock_product_id, 'despiece', v_weight,
          'carcass_cut', v_cut_id, 'Despiece · ' || t.cut_name, p_user_id
        )
        returning id into v_movement_id;
      end if;
      insert into public.carcass_cuts (id, batch_id, cut_name, product_id, weight, unit_price, line_total, inventory_movement_id, from_template)
      values (v_cut_id, p_batch_id, t.cut_name, t.stock_product_id, v_weight,
              coalesce(t.price, 0), round(v_weight * coalesce(t.price, 0), 2), v_movement_id, true);
      v_count := v_count + 1;
    end loop;
    if v_count > 0 then
      update public.carcass_batches
      set fill_source = jsonb_build_object('kind', 'learned', 'batches', v_n, 'min', v_min, 'max', v_max)
      where id = p_batch_id;
      return v_count;
    end if;
  end if;

  -- 2. Cortes de siempre (igual que la 162).
  select coalesce(sum(yield_percent), 0) into v_sum
  from public.carcass_cut_templates
  where company_id = v_batch.company_id and public.carcass_type_key(animal_type) = v_key;
  if v_sum <= 0 or v_sum > 100 then
    return 0;
  end if;

  for t in
    select ct.cut_name, ct.yield_percent, ct.product_id, p.price_retail
    from public.carcass_cut_templates ct
    left join public.products p on p.id = ct.product_id and p.company_id = v_batch.company_id
    where ct.company_id = v_batch.company_id and public.carcass_type_key(ct.animal_type) = v_key
    order by ct.sort_order, ct.created_at
  loop
    v_weight := round(v_batch.total_weight * (t.yield_percent / 100), 3);
    continue when v_weight <= 0;
    v_cut_id := gen_random_uuid();
    v_movement_id := null;
    if t.product_id is not null and t.price_retail is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by
      ) values (
        v_batch.company_id, v_batch.branch_id, t.product_id, 'despiece', v_weight,
        'carcass_cut', v_cut_id, 'Despiece · ' || trim(t.cut_name), p_user_id
      )
      returning id into v_movement_id;
    end if;
    insert into public.carcass_cuts (id, batch_id, cut_name, product_id, weight, unit_price, line_total, inventory_movement_id, from_template)
    values (v_cut_id, p_batch_id, trim(t.cut_name), case when t.price_retail is not null then t.product_id end, v_weight,
            coalesce(t.price_retail, 0), round(v_weight * coalesce(t.price_retail, 0), 2), v_movement_id, true);
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    update public.carcass_batches set fill_source = jsonb_build_object('kind', 'template') where id = p_batch_id;
  end if;
  return v_count;
end;
$fn$;

revoke all on function public.carcass_fill_from_template(uuid, uuid) from public, anon, authenticated;

-- Interno: quién llama y su res (misma empresa).
create or replace function public.carcass_caller_batch(p_batch_id uuid)
returns public.carcass_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_batch public.carcass_batches%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;
  select * into v_profile from public.profiles where id = auth.uid() and active = true;
  if v_profile.id is null then
    raise exception 'Perfil inválido';
  end if;
  select * into v_batch from public.carcass_batches where id = p_batch_id and company_id = v_profile.company_id for update;
  if v_batch.id is null then
    raise exception 'Res inválida';
  end if;
  return v_batch;
end;
$$;

revoke all on function public.carcass_caller_batch(uuid) from public, anon, authenticated;

-- Repartir una res sin cortes desde Despiece. p_use_defaults: si no hay cortes de siempre, usar los típicos.
create or replace function public.fill_carcass_batch(p_batch_id uuid, p_use_defaults boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.carcass_batches%rowtype;
  v_cuts int;
begin
  perform public.require_plan('estandar');
  v_batch := public.carcass_caller_batch(p_batch_id);
  if exists (select 1 from public.carcass_cuts where batch_id = p_batch_id) then
    raise exception 'Esta res ya tiene cortes.';
  end if;
  if p_use_defaults then
    perform public.carcass_ensure_default_templates(v_batch.company_id, v_batch.animal_type);
  end if;
  v_cuts := public.carcass_fill_from_template(p_batch_id, auth.uid());
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_batch.company_id, v_batch.branch_id, auth.uid(), 'carcass.fill', 'carcass_batch', p_batch_id::text,
          jsonb_build_object('cuts', v_cuts));
  return jsonb_build_object('cuts', v_cuts, 'source', (select fill_source from public.carcass_batches where id = p_batch_id));
end;
$$;

revoke all on function public.fill_carcass_batch(uuid, boolean) from public, anon;
grant execute on function public.fill_carcass_batch(uuid, boolean) to authenticated;

-- "Listo, la pesé": los cortes de esta res pasan a ser pesados de verdad (sirven para aprender, y la compra ya no los
-- rehace si se corrigen los kilos de la factura).
create or replace function public.mark_carcass_batch_weighed(p_batch_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.carcass_batches%rowtype;
  v_count int;
begin
  perform public.require_plan('estandar');
  v_batch := public.carcass_caller_batch(p_batch_id);
  update public.carcass_cuts set from_template = false where batch_id = p_batch_id and from_template;
  get diagnostics v_count = row_count;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_batch.company_id, v_batch.branch_id, auth.uid(), 'carcass.weighed', 'carcass_batch', p_batch_id::text,
          jsonb_build_object('cuts', v_count));
  return v_count;
end;
$$;

revoke all on function public.mark_carcass_batch_weighed(uuid) from public, anon;
grant execute on function public.mark_carcass_batch_weighed(uuid) to authenticated;

insert into public.schema_migrations (version) values ('163_carcass_learned_yields') on conflict do nothing;
