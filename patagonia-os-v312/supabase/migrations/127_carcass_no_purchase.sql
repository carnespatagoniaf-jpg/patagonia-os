-- 127: Despiece ya no crea compras (2026-10-15, pedido del dueño: "Despiece es solo para despostes, para saber cuánto
-- me quedó de cada media, cajón o capón").
--
-- La factura del proveedor (y su deuda) se carga en Compras; lo que se desposta va como línea "Para despostar" (126).
-- Una res cargada en Despiece con proveedor ya NO genera una compra: el proveedor queda solo como dato.
-- Las reses viejas que ya tienen su compra (069) la siguen actualizando al corregirlas, para no cambiar deudas que ya
-- existen. Antes se borraba y se recreaba esa compra, y eso fallaba siempre (la res todavía apuntaba a la compra:
-- carcass_batches_purchase_id_fkey); ahora se actualiza en el lugar. Si se le saca el proveedor, la compra se borra
-- después de desvincularla (como antes, la deuda desaparece).
--
-- Reemplaza el cuerpo entero (la 126 ya había inyectado su control; se mantiene igual, y require_plan primero).

create or replace function public.save_carcass_batch(p_batch_id uuid, p_branch_id uuid, p_batch_date date, p_animal_type text, p_supplier_id uuid, p_total_weight numeric, p_total_cost numeric, p_notes text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid;
  v_existing_purchase_id uuid;
begin
  perform public.require_plan('estandar');
  -- 126: la res de una compra se corrige en Compras.
  if p_batch_id is not null and exists (select 1 from public.carcass_batches where id = p_batch_id and purchase_item_id is not null) then
    raise exception 'Esta res viene de una compra: el peso, el costo, la fecha y el proveedor se corrigen en Compras';
  end if;

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

    update public.carcass_batches
    set batch_date = p_batch_date, animal_type = trim(p_animal_type), supplier_id = p_supplier_id,
        total_weight = p_total_weight, total_cost = p_total_cost, notes = p_notes,
        purchase_id = case when p_supplier_id is null then null else purchase_id end
    where id = p_batch_id and company_id = v_company_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Registro inválido';
    end if;

    -- 127: res vieja con su compra (069): se actualiza en el lugar; sin proveedor, se borra.
    if v_existing_purchase_id is not null then
      if p_supplier_id is null then
        delete from public.purchase_items where purchase_id = v_existing_purchase_id;
        delete from public.purchases where id = v_existing_purchase_id and company_id = v_company_id;
      else
        update public.purchases
        set supplier_id = p_supplier_id, purchase_date = p_batch_date, total = p_total_cost
        where id = v_existing_purchase_id and company_id = v_company_id;
        update public.purchase_items
        set description = trim(p_animal_type) || ' (' || p_total_weight || ' kg)', quantity = p_total_weight,
            unit_price = round(p_total_cost / p_total_weight, 2), line_total = p_total_cost
        where purchase_id = v_existing_purchase_id;
      end if;
    end if;
  else
    -- 127: una res nueva nunca crea compra; la factura va en Compras.
    if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
      raise exception 'Sucursal inválida';
    end if;
    v_id := gen_random_uuid();
    insert into public.carcass_batches (
      id, company_id, branch_id, batch_date, animal_type, supplier_id, total_weight, total_cost, notes, purchase_id, created_by
    ) values (
      v_id, v_company_id, p_branch_id, p_batch_date, trim(p_animal_type), p_supplier_id, p_total_weight, p_total_cost, p_notes, null, v_user_id
    );
  end if;

  return jsonb_build_object('id', v_id);
end;
$function$;

revoke all on function public.save_carcass_batch(uuid, uuid, date, text, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.save_carcass_batch(uuid, uuid, date, text, uuid, numeric, numeric, text) to authenticated;

insert into public.schema_migrations (version) values ('127_carcass_no_purchase') on conflict do nothing;
