-- 123: el costo real de cada corte pasa SOLO a Stock (2026-10-15, pedido del dueño: "¿por qué tengo que tocar un botón?").
--
-- Cada vez que se carga, cambia o borra un corte, o se cambia lo que costó la res, se recalcula el reparto de esa res
-- (la misma cuenta de la 122 y de allocateCarcassCost) y se escribe el costo por kilo en sus productos.
-- Protección: un producto toma el costo de la res MÁS NUEVA en la que aparece. Corregir una res vieja no pisa el
-- costo que ya puso una res más reciente. Solo productos por kilo. Se audita solo cuando algún costo cambia.

-- Interno: no lo llama nadie desde afuera (revocado de anon y authenticated).
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

  select coalesce(sum(weight * unit_price), 0), coalesce(sum(weight), 0)
  into v_total_value, v_total_weight
  from public.carcass_cuts where batch_id = p_batch_id;
  if v_total_weight <= 0 then
    return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
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
    if v_old is distinct from v_new then
      update public.products set cost = v_new where id = r.product_id;
      v_out := v_out || jsonb_build_object('product_id', r.product_id, 'old_cost', v_old, 'new_cost', v_new, 'weight', r.weight);
    end if;
  end loop;

  if jsonb_array_length(v_out) > 0 then
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_branch_id, p_user_id, 'carcass.apply_costs', 'carcass_batch', p_batch_id::text,
            jsonb_build_object('total_cost', v_total_cost, 'products', v_out, 'skipped', v_skipped, 'automatic', true));
  end if;
  return jsonb_build_object('updated', v_out, 'skipped', v_skipped);
end;
$$;

revoke all on function public.carcass_apply_costs_core(uuid, uuid) from public, anon, authenticated;

-- Automático: cortes.
create or replace function public.carcass_cuts_auto_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.carcass_apply_costs_core(new.batch_id, auth.uid());
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.batch_id is distinct from new.batch_id) then
    perform public.carcass_apply_costs_core(old.batch_id, auth.uid());
  end if;
  return null;
end;
$$;

drop trigger if exists carcass_cuts_auto_cost on public.carcass_cuts;
create trigger carcass_cuts_auto_cost
  after insert or update or delete on public.carcass_cuts
  for each row execute function public.carcass_cuts_auto_cost();

-- Automático: cambia lo que costó la res.
create or replace function public.carcass_batches_auto_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.total_cost is distinct from old.total_cost or new.batch_date is distinct from old.batch_date then
    perform public.carcass_apply_costs_core(new.id, auth.uid());
  end if;
  return null;
end;
$$;

drop trigger if exists carcass_batches_auto_cost on public.carcass_batches;
create trigger carcass_batches_auto_cost
  after update on public.carcass_batches
  for each row execute function public.carcass_batches_auto_cost();

revoke all on function public.carcass_cuts_auto_cost() from public, anon, authenticated;
revoke all on function public.carcass_batches_auto_cost() from public, anon, authenticated;

-- El botón de la 122 ya no hace falta en la pantalla; la función queda (misma cuenta) por compatibilidad.
insert into public.schema_migrations (version) values ('123_carcass_costs_automatic') on conflict do nothing;
