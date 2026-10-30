-- 170: Despiece — "Costo parejo por kilo" a elección de cada carnicería (2026-10-29, pedido de La cosa es con carne).
--
-- "Si yo compro la media al mismo precio, no puede ser que el asado me cueste 14.300 y el vacío 15.200."
-- Dos formas de repartir lo que se pagó por una res entre sus cortes:
--   * Por defecto (como siempre, 122/123): según lo que VALE cada corte (kilos × precio de venta). El que se vende
--     más caro carga más costo y todos dejan el mismo margen. NO cambia para ninguna empresa.
--   * Con 'costo_parejo' en companies.features: lo que se pagó ÷ los kilos de los cortes que se venden (con precio).
--     Todos cuestan lo mismo por kilo; hueso y grasa sin precio son merma (costo 0). Cada corte deja su margen.
-- Si ningún corte tiene precio, las dos reparten por kilos. Con costo parejo, un corte sin precio no le borra el costo a su producto.
-- La MISMA cuenta, con el mismo redondeo, está en allocateCarcassCost (packages/domain): cambiar las dos juntas.
-- apply_carcass_costs (botón "Actualizar costos en Stock") ahora usa esta misma cuenta.
-- 'costo_parejo' se prende desde el panel de plataforma ("Pantallas a pedido", set_company_feature).
-- No recalcula nada solo: el costo nuevo se escribe al tocar un corte o el precio de la res, o con el botón.

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
  v_sellable_weight numeric;
  v_by_value boolean;
  r record;
  v_old numeric;
  v_new numeric;
  v_out jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  select company_id, branch_id, total_cost, batch_date, created_at
  into v_company_id, v_branch_id, v_total_cost, v_batch_date, v_created_at
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

-- Botón "Actualizar costos en Stock": mismos controles que en la 122, la cuenta es la de carcass_apply_costs_core.
create or replace function public.apply_carcass_costs(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador cambia los costos';
  end if;
  if not exists (select 1 from public.carcass_batches where id = p_batch_id and company_id = v_company_id) then
    raise exception 'Res inválida';
  end if;
  if not exists (select 1 from public.carcass_cuts where batch_id = p_batch_id and weight > 0) then
    raise exception 'La res todavía no tiene cortes cargados';
  end if;
  return public.carcass_apply_costs_core(p_batch_id, v_user_id);
end;
$$;
revoke all on function public.apply_carcass_costs(uuid) from public, anon;
grant execute on function public.apply_carcass_costs(uuid) to authenticated;

-- Panel de plataforma: 'costo_parejo' se suma a las opciones que se prenden por empresa.
create or replace function public.set_company_feature(p_company_id uuid, p_feature text, p_enabled boolean)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_features text[];
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_feature is null or p_feature not in ('frigorifico', 'cuentas', 'gastos', 'reporte_ventas', 'ventas_detalle', 'paquetes', 'venta_ruta', 'costo_parejo') then
    raise exception 'Pantalla inválida';
  end if;
  update public.companies
  set features = case
    when coalesce(p_enabled, false) then (select array(select distinct unnest(features || array[p_feature])))
    else array_remove(features, p_feature)
  end
  where id = p_company_id
  returning features into v_features;
  if not found then
    raise exception 'Cliente inválido';
  end if;
  return v_features;
end;
$$;
revoke all on function public.set_company_feature(uuid, text, boolean) from public, anon;
grant execute on function public.set_company_feature(uuid, text, boolean) to authenticated;

insert into public.schema_migrations (version) values ('170_carcass_average_cost') on conflict do nothing;
