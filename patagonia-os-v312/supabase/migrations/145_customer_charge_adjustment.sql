-- Clientes → Nueva venta (fiado): descuento o recargo sobre el total
-- (2026-10-22, pedido de Martínez, SOLO para empresas con 'ventas_detalle' en
-- companies.features, migración 143).
--
-- create_customer_charge_with_items suma p_adjustment (negativo = descuento,
-- positivo = recargo) al total de los renglones. No se guarda en ninguna
-- columna nueva: los renglones quedan como siempre (precio >= 0, ver
-- customer_charge_items_unit_price_check) y el ajuste es la diferencia entre
-- customer_charges.amount y la suma de sus renglones; la web lo muestra así.
-- Queda en audit_log ('adjustment').
--
-- Cuerpo = el vivo en prod y staging (idénticos, verificado 2026-10-22) + el
-- ajuste. Se mantiene require_plan('estandar') como primera línea. Se borra la
-- versión de 5 argumentos: con las dos, PostgREST no sabría cuál llamar.

drop function if exists public.create_customer_charge_with_items(uuid, uuid, date, jsonb, text);

create or replace function public.create_customer_charge_with_items(
  p_customer_id uuid,
  p_branch_id uuid,
  p_charge_date date,
  p_items jsonb,
  p_reason text default null,
  p_adjustment numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_charge_id uuid := gen_random_uuid();
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_quantity numeric(14,3);
  v_unit_price numeric(14,2);
  v_description text;
  v_is_manual boolean;
  v_line_total numeric(14,2);
  v_reason text;
  v_summary text[] := array[]::text[];
  v_adjustment numeric(14,2) := round(coalesce(p_adjustment, 0));
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id
  ) then
    raise exception 'Cliente inválido';
  end if;

  if v_adjustment <> 0 and not exists (
    select 1 from public.companies where id = v_company_id and 'ventas_detalle' = any(features)
  ) then
    raise exception 'Esta empresa no tiene descuento o recargo en la venta';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La entrega no tiene productos';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_is_manual := (v_item->>'product_id') is null;
    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Cantidad inválida';
    end if;

    if v_is_manual then
      v_description := nullif(trim(v_item->>'description'), '');
      if v_description is null then
        raise exception 'El artículo manual necesita una descripción';
      end if;
      v_unit_price := (v_item->>'unit_price')::numeric;
      if v_unit_price is null or v_unit_price < 0 then
        raise exception 'Precio inválido';
      end if;
      v_line_total := v_quantity * v_unit_price;
      v_summary := v_summary || v_description;
    else
      select * into v_product
      from public.products
      where id = (v_item->>'product_id')::uuid
        and company_id = v_company_id
        and active = true
      for update;

      if not found then
        raise exception 'Producto inválido';
      end if;

      v_line_total := v_quantity * v_product.price_retail;
      v_summary := v_summary || v_product.name;
    end if;

    v_total := v_total + v_line_total;
  end loop;

  v_total := round(v_total) + v_adjustment;
  if v_total <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then
    v_reason := array_to_string(v_summary, ', ');
  end if;

  insert into public.customer_charges (id, company_id, customer_id, charge_date, amount, reason, created_by)
  values (v_charge_id, v_company_id, p_customer_id, p_charge_date, v_total, v_reason, v_user_id);

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_is_manual := (v_item->>'product_id') is null;
    v_quantity := (v_item->>'quantity')::numeric;

    if v_is_manual then
      v_description := trim(v_item->>'description');
      v_unit_price := (v_item->>'unit_price')::numeric;

      insert into public.customer_charge_items (charge_id, product_id, description, quantity, unit_price, line_total)
      values (v_charge_id, null, v_description, v_quantity, v_unit_price, v_quantity * v_unit_price);
    else
      select * into v_product
      from public.products
      where id = (v_item->>'product_id')::uuid;

      v_unit_price := v_product.price_retail;

      insert into public.customer_charge_items (charge_id, product_id, description, quantity, unit_price, line_total)
      values (v_charge_id, v_product.id, v_product.name, v_quantity, v_unit_price, v_quantity * v_unit_price);

      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, p_branch_id, v_product.id, 'venta_cuenta_corriente', -v_quantity,
        'customer_charge', v_charge_id, 'Entrega a cliente de cuenta corriente', v_user_id
      );
    end if;
  end loop;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'customer_charge.create', 'customer_charge', v_charge_id::text,
    jsonb_build_object('amount', v_total, 'customer_id', p_customer_id, 'items', p_items, 'adjustment', v_adjustment)
  );

  return jsonb_build_object('id', v_charge_id, 'amount', v_total);
end;
$$;

revoke all on function public.create_customer_charge_with_items(uuid, uuid, date, jsonb, text, numeric) from public, anon;
grant execute on function public.create_customer_charge_with_items(uuid, uuid, date, jsonb, text, numeric) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('145_customer_charge_adjustment') on conflict do nothing;
