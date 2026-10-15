-- 122: Despiece → costo real de cada corte en Stock (2026-10-15, pedido del dueño).
--
-- Despiece ya sumaba el stock de cada corte (029), pero el costo de los productos seguía siendo el cargado a mano.
-- apply_carcass_costs reparte la compra de la res entre sus cortes según lo que VALE cada uno (kilos × precio de
-- venta; si ningún corte tiene precio, por kilos) y escribe el costo por kilo en cada producto vinculado.
-- Es la MISMA cuenta que allocateCarcassCost (packages/domain), con el mismo redondeo: cambiar las dos juntas.
-- Solo productos que se venden por kilo (el costo de los otros no es por kilo). Dueño o administrador. Auditado.

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
  v_branch_id uuid;
  v_total_cost numeric;
  v_total_value numeric;
  v_total_weight numeric;
  r record;
  v_new numeric;
  v_out jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador cambia los costos';
  end if;

  select branch_id, total_cost into v_branch_id, v_total_cost
  from public.carcass_batches
  where id = p_batch_id and company_id = v_company_id;

  if v_branch_id is null then
    raise exception 'Res inválida';
  end if;

  select coalesce(sum(weight * unit_price), 0), coalesce(sum(weight), 0)
  into v_total_value, v_total_weight
  from public.carcass_cuts
  where batch_id = p_batch_id;

  if v_total_weight <= 0 then
    raise exception 'La res todavía no tiene cortes cargados';
  end if;

  for r in
    select c.product_id,
           sum(c.weight) as weight,
           sum(case when v_total_value > 0 then v_total_cost * (c.weight * c.unit_price) / v_total_value
                    else v_total_cost * c.weight / v_total_weight end) as cost
    from public.carcass_cuts c
    where c.batch_id = p_batch_id and c.product_id is not null
    group by c.product_id
  loop
    -- Lock del producto: el costo es plata.
    perform 1 from public.products where id = r.product_id and company_id = v_company_id for update;
    if not found then
      continue;
    end if;
    if (select unit from public.products where id = r.product_id) <> 'kg' then
      v_skipped := v_skipped || jsonb_build_object('product_id', r.product_id, 'reason', 'no se vende por kilo');
      continue;
    end if;
    v_new := case when r.weight > 0 then round(r.cost / r.weight, 2) else 0 end;
    v_out := v_out || (
      select jsonb_build_object('product_id', p.id, 'name', p.name, 'old_cost', p.cost, 'new_cost', v_new, 'weight', r.weight)
      from public.products p where p.id = r.product_id
    );
    update public.products set cost = v_new where id = r.product_id;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_branch_id, v_user_id, 'carcass.apply_costs', 'carcass_batch', p_batch_id::text,
          jsonb_build_object('total_cost', v_total_cost, 'products', v_out, 'skipped', v_skipped));

  return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
end;
$$;

revoke all on function public.apply_carcass_costs(uuid) from public, anon;
grant execute on function public.apply_carcass_costs(uuid) to authenticated;

insert into public.schema_migrations (version) values ('122_carcass_real_costs') on conflict do nothing;
