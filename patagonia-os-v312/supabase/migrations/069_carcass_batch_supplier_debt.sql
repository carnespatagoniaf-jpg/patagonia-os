-- El dueño esperaba que cargar una media res en Despiece con un proveedor
-- sumara sola a la cuenta corriente de ese proveedor, igual que una Compra
-- -- hoy supplier_id en carcass_batches era solo informativo, sin generar
-- ninguna deuda real. Se soluciona creando (y manteniendo sincronizada) una
-- fila real en purchases/purchase_items por cada res con proveedor, así
-- aparece en Compras -- Ver cuenta -- Detalle, y se puede pagar desde ahí
-- o desde el pago a proveedor de Mostrador (065), sin duplicar ninguna
-- lógica de cuenta corriente/tesorería.
--
-- supplier_payments no está ligado a una compra puntual (solo a
-- supplier_id), así que borrar y recrear la purchase en cada edición es
-- seguro -- nunca deja un pago ya registrado sin destino.
alter table public.carcass_batches
  add column if not exists purchase_id uuid references public.purchases(id);

create or replace function public.save_carcass_batch(
  p_batch_id uuid,
  p_branch_id uuid,
  p_batch_date date,
  p_animal_type text,
  p_supplier_id uuid,
  p_total_weight numeric,
  p_total_cost numeric,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid;
  v_existing_purchase_id uuid;
  v_purchase_id uuid;
  v_description text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_animal_type is null or length(trim(p_animal_type)) = 0 then
    raise exception 'El tipo de animal es obligatorio';
  end if;

  if p_total_weight is null or p_total_weight <= 0 then
    raise exception 'El peso total debe ser mayor que cero';
  end if;

  if p_total_cost is null or p_total_cost < 0 then
    raise exception 'El costo total no puede ser negativo';
  end if;

  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = p_supplier_id and company_id = v_company_id
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_batch_id is not null then
    select purchase_id into v_existing_purchase_id
    from public.carcass_batches
    where id = p_batch_id and company_id = v_company_id;
  end if;

  -- Se borra la compra vinculada anterior (si había) y se recrea de cero
  -- con los valores actuales -- más simple que actualizarla in-place, y
  -- seguro porque ningún pago depende de una compra puntual.
  if v_existing_purchase_id is not null then
    delete from public.purchase_items where purchase_id = v_existing_purchase_id;
    delete from public.purchases where id = v_existing_purchase_id;
  end if;

  v_purchase_id := null;
  if p_supplier_id is not null then
    v_purchase_id := gen_random_uuid();
    v_description := trim(p_animal_type) || ' (' || p_total_weight || ' kg)';

    insert into public.purchases (
      id, company_id, branch_id, supplier_id, purchase_date, invoice_number, total, status, created_by
    ) values (
      v_purchase_id, v_company_id, p_branch_id, p_supplier_id, p_batch_date, null, p_total_cost, 'active', v_user_id
    );

    insert into public.purchase_items (
      purchase_id, product_id, description, quantity, unit, unit_price, line_total
    ) values (
      v_purchase_id, null, v_description, p_total_weight, 'kg',
      case when p_total_weight > 0 then round(p_total_cost / p_total_weight, 2) else 0 end, p_total_cost
    );
  end if;

  if p_batch_id is not null then
    update public.carcass_batches
    set batch_date = p_batch_date, animal_type = trim(p_animal_type), supplier_id = p_supplier_id,
        total_weight = p_total_weight, total_cost = p_total_cost, notes = p_notes, purchase_id = v_purchase_id
    where id = p_batch_id and company_id = v_company_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Registro inválido';
    end if;
  else
    v_id := gen_random_uuid();
    insert into public.carcass_batches (
      id, company_id, branch_id, batch_date, animal_type, supplier_id, total_weight, total_cost, notes, purchase_id, created_by
    ) values (
      v_id, v_company_id, p_branch_id, p_batch_date, trim(p_animal_type), p_supplier_id, p_total_weight, p_total_cost, p_notes, v_purchase_id, v_user_id
    );
  end if;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_carcass_batch(uuid,uuid,date,text,uuid,numeric,numeric,text) from public;
grant execute on function public.save_carcass_batch(uuid,uuid,date,text,uuid,numeric,numeric,text) to authenticated;

create or replace function public.delete_carcass_batch(
  p_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_purchase_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select purchase_id into v_purchase_id
  from public.carcass_batches
  where id = p_batch_id and company_id = v_company_id;

  -- Desvincular antes de borrar los movimientos, para no violar la foreign
  -- key mientras carcass_cuts todavía apunta a ellos.
  update public.carcass_cuts cc
  set inventory_movement_id = null
  where cc.batch_id = p_batch_id and cc.inventory_movement_id is not null;

  delete from public.inventory_movements im
  where im.reference_type = 'carcass_cut'
    and im.reference_id in (select id from public.carcass_cuts where batch_id = p_batch_id);

  delete from public.carcass_batches where id = p_batch_id and company_id = v_company_id;

  if v_purchase_id is not null then
    delete from public.purchase_items where purchase_id = v_purchase_id;
    delete from public.purchases where id = v_purchase_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_batch(uuid) from public;
grant execute on function public.delete_carcass_batch(uuid) to authenticated;
