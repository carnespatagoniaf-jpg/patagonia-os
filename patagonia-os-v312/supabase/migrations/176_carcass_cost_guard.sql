-- 176: Despiece — el costo automático nunca escribe en Stock un costo imposible (2026-10-30).
--
-- REAL (Tienda de carnes, 30/10): media res de 155 kg a $1.395.000 repartida con los cortes de fábrica; 16 de los 23
-- cortes no se unieron a sus productos (nombres distintos) y quedaron sin precio. Por valor, todo lo pagado cayó en los
-- 7 cortes con precio: lomo $308.219/kg, tapa de asado $562.500/kg (antes $8.900). Y cada corte que la persona borraba
-- volvía a repartir y a escribir en Stock (unas 30 veces en 15 minutos; "blando común" quedó en $642.857/kg).
--
-- Freno en carcass_apply_costs_core (la usan los disparadores automáticos y el botón "Actualizar costos en Stock"), por
-- valor y con costo parejo: si lo que se pagó es más de 1,5 veces lo que vale la res vendida (kilos × precio de los
-- cortes), no se escribe ningún costo y devuelve "blocked". Con costo parejo un corte barato puede costar más que su
-- precio (es la idea de ese método), por eso el freno mira la res entera y no cada producto.
-- Segundo freno: si los cortes pesan menos de la mitad de lo que pesó la res, tampoco se escribe ("blocked").
-- La cuenta no cambia (allocateCarcassCost sigue igual; la pantalla muestra lo mismo): solo deja de escribirse lo absurdo.

create or replace function public.carcass_apply_costs_core(p_batch_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_branch_id uuid;
  v_total_cost numeric;
  v_batch_date date;
  v_created_at timestamptz;
  v_total_value numeric;
  v_total_weight numeric;
  v_batch_weight numeric;
  v_sellable_weight numeric;
  v_by_value boolean;
  r record;
  v_old numeric;
  v_new numeric;
  v_out jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  select company_id, branch_id, total_cost, batch_date, created_at, total_weight
  into v_company_id, v_branch_id, v_total_cost, v_batch_date, v_created_at, v_batch_weight
  from public.carcass_batches where id = p_batch_id;
  if v_company_id is null then
    return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
  end if;

  select not coalesce('costo_parejo' = any(features), false) into v_by_value from public.companies where id = v_company_id;

  select coalesce(sum(weight * unit_price), 0), coalesce(sum(weight), 0),
         coalesce(sum(case when unit_price > 0 then weight else 0 end), 0)
  into v_total_value, v_total_weight, v_sellable_weight
  from public.carcass_cuts where batch_id = p_batch_id;
  if v_total_weight <= 0 then
    return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
  end if;

  -- 176: si lo que se pagó es más de 1,5 veces lo que vale la res vendida, faltan precios (cortes sin producto): no es
  -- un costo real. No se toca Stock hasta que se completen. (Una res que se vende algo por debajo de lo pagado sí se
  -- reparte: es una pérdida de verdad. Real 30/10: pagó 4,3 veces lo que valía con los precios cargados.)
  -- Los cortes pesan menos de la mitad de la res (se borraron o todavía se están cargando): lo pagado caería entero en
  -- esos pocos kilos. Real 30/10: con 1 corte de 2,17 kg, "blando común" quedó en $642.857/kg.
  if coalesce(v_batch_weight, 0) > 0 and v_total_weight < 0.5 * v_batch_weight then
    return jsonb_build_object('updated', v_out, 'skipped', v_skipped, 'blocked',
      'Los cortes cargados pesan menos de la mitad de la res: faltan cortes. No se cambió ningún costo en Stock.');
  end if;
  if v_total_value > 0 and v_total_cost > 1.5 * v_total_value then
    return jsonb_build_object('updated', v_out, 'skipped', v_skipped, 'blocked',
      'La res vale vendida menos de lo que pagaste: faltan precios en los cortes. No se cambió ningún costo en Stock.');
  end if;

  for r in
    select c.product_id,
           sum(c.weight) as weight,
           sum(case
                 when v_total_value <= 0 then v_total_cost * c.weight / v_total_weight
                 when v_by_value then v_total_cost * (c.weight * c.unit_price) / v_total_value
                 when c.unit_price > 0 and v_sellable_weight > 0 then v_total_cost * c.weight / v_sellable_weight
                 else 0
               end) as cost
    from public.carcass_cuts c
    where c.batch_id = p_batch_id and c.product_id is not null
    group by c.product_id
  loop
    select cost into v_old from public.products
    where id = r.product_id and company_id = v_company_id and unit = 'kg'
    for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('product_id', r.product_id, 'reason', 'no se vende por kilo');
      continue;
    end if;
    -- Una res más nueva con este producto manda.
    if exists (
      select 1 from public.carcass_cuts c2 join public.carcass_batches b2 on b2.id = c2.batch_id
      where c2.product_id = r.product_id and b2.company_id = v_company_id and b2.id <> p_batch_id
        and (b2.batch_date > v_batch_date or (b2.batch_date = v_batch_date and b2.created_at > v_created_at))
    ) then
      v_skipped := v_skipped || jsonb_build_object('product_id', r.product_id, 'reason', 'lo define una res más nueva');
      continue;
    end if;
    v_new := case when r.weight > 0 then round(r.cost / r.weight, 2) else 0 end;
    -- Costo parejo: un corte que no se vende (hueso, grasa: costo 0) no le borra el costo a su producto.
    -- (Por valor queda exactamente como en la 123.)
    if not v_by_value and v_new = 0 and coalesce(v_old, 0) > 0 then
      v_skipped := v_skipped || jsonb_build_object('product_id', r.product_id, 'reason', 'sin precio de venta en esta res');
      continue;
    end if;
    if v_old is distinct from v_new then
      update public.products set cost = v_new where id = r.product_id;
      v_out := v_out || jsonb_build_object('product_id', r.product_id, 'old_cost', v_old, 'new_cost', v_new, 'weight', r.weight);
    end if;
  end loop;

  if jsonb_array_length(v_out) > 0 then
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_branch_id, p_user_id, 'carcass.apply_costs', 'carcass_batch', p_batch_id::text,
            jsonb_build_object('total_cost', v_total_cost, 'products', v_out, 'skipped', v_skipped, 'automatic', true,
                               'method', case when v_by_value then 'value' else 'average' end));
  end if;
  return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
end;
$$;

revoke all on function public.carcass_apply_costs_core(uuid, uuid) from public, anon, authenticated;

insert into public.schema_migrations (version) values ('176_carcass_cost_guard') on conflict do nothing;
