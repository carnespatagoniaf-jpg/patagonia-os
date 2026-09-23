-- Riesgo real encontrado en auditoría (2026-09-23): la cola de ventas
-- offline (offline-queue.ts) reintenta una venta si createPosSale falla
-- por corte de red -- pero si el corte pasa justo DESPUÉS de que el
-- servidor ya procesó la venta y ANTES de que la confirmación vuelva al
-- navegador, el cliente no tiene forma de saberlo: la reintenta, y el
-- servidor (que tampoco lo sabe) la carga de nuevo. Resultado: venta,
-- descuento de stock e ingreso a caja duplicados.
--
-- Se agrega una clave de idempotencia: el cliente genera un uuid único
-- por intento de venta (crypto.randomUUID(), una sola vez, reusado en
-- cada reintento de la cola offline) y create_pos_sale, si ya existe una
-- venta con esa clave para la empresa, devuelve esa venta tal cual en vez
-- de crear una nueva -- un reintento nunca duplica nada.
alter table public.pos_sales add column if not exists idempotency_key uuid;
create unique index if not exists pos_sales_company_idempotency_key
  on public.pos_sales (company_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.create_pos_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_pos_shift_id uuid,
  p_discount_amount numeric default 0,
  p_surcharge_amount numeric default 0,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale_id uuid := gen_random_uuid();
  v_existing_sale_id uuid;
  v_existing_total numeric(14,2);
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_quantity numeric(14,3);
  v_unit_price numeric(14,2);
  v_description text;
  v_is_manual boolean;
  v_item_discount numeric(14,2);
  v_line_total numeric(14,2);
  v_payment_amount numeric(14,2);
  v_payments_total numeric(14,2) := 0;
  v_payment_method text;
  v_payment_active boolean;
  v_payment_reference text;
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

  if p_idempotency_key is not null then
    select id, total into v_existing_sale_id, v_existing_total
    from public.pos_sales
    where company_id = v_company_id and idempotency_key = p_idempotency_key;

    if v_existing_sale_id is not null then
      return jsonb_build_object('sale_id', v_existing_sale_id, 'total', v_existing_total);
    end if;
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.pos_shifts
    where id = p_pos_shift_id and company_id = v_company_id and branch_id = p_branch_id and status = 'open'
  ) then
    raise exception 'No hay un turno de mostrador abierto';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'Falta el medio de pago';
  end if;

  if p_discount_amount is null or p_discount_amount < 0 then
    raise exception 'Descuento inválido';
  end if;

  if p_surcharge_amount is null or p_surcharge_amount < 0 then
    raise exception 'Recargo inválido';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_is_manual := (v_item->>'product_id') is null;
    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    if v_item_discount < 0 then
      raise exception 'Descuento inválido';
    end if;
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
      v_line_total := (v_quantity * v_unit_price) - v_item_discount;
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

      v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;
    end if;

    if v_line_total < 0 then
      raise exception 'El descuento supera el precio de un ítem';
    end if;

    v_total := v_total + v_line_total;
  end loop;

  v_total := round(v_total - p_discount_amount + p_surcharge_amount);
  if v_total < 0 then
    raise exception 'El descuento supera el total de la venta';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    select payment_method, active into v_payment_method, v_payment_active
    from public.treasury_accounts
    where id = (v_payment->>'account_id')::uuid and company_id = v_company_id;

    if not found then
      raise exception 'Cuenta de tesorería inválida';
    end if;

    if v_payment_active is not true then
      raise exception 'Esa cuenta de cobro está desactivada -- elegí otra (F5 para actualizar la pantalla si la acaban de desactivar).';
    end if;

    v_payment_amount := (v_payment->>'amount')::numeric;
    if v_payment_amount is null or v_payment_amount <= 0 then
      raise exception 'Monto de pago inválido';
    end if;

    v_payment_reference := nullif(trim(v_payment->>'reference'), '');
    if coalesce(v_payment_method, '') <> 'cash' and v_payment_reference is null then
      raise exception 'Falta el cupón o número de operación para un pago que no es en efectivo';
    end if;

    v_payments_total := v_payments_total + v_payment_amount;
  end loop;

  if round(v_payments_total) <> v_total then
    raise exception 'Los medios de pago no suman el total de la venta';
  end if;

  insert into public.pos_sales (id, company_id, branch_id, total, pos_shift_id, discount_amount, surcharge_amount, created_by, idempotency_key)
  values (v_sale_id, v_company_id, p_branch_id, v_total, p_pos_shift_id, p_discount_amount, p_surcharge_amount, v_user_id, p_idempotency_key);

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    insert into public.pos_sale_payments (sale_id, account_id, amount, reference)
    values (v_sale_id, (v_payment->>'account_id')::uuid, (v_payment->>'amount')::numeric, nullif(trim(v_payment->>'reference'), ''));
  end loop;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_is_manual := (v_item->>'product_id') is null;
    v_quantity := (v_item->>'quantity')::numeric;
    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);

    if v_is_manual then
      v_description := trim(v_item->>'description');
      v_unit_price := (v_item->>'unit_price')::numeric;

      insert into public.pos_sale_items (sale_id, product_id, description, quantity, unit_price, discount_amount, line_total)
      values (v_sale_id, null, v_description, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);
    else
      select * into v_product
      from public.products
      where id = (v_item->>'product_id')::uuid;

      v_unit_price := v_product.price_retail;

      insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total)
      values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);

      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, p_branch_id, v_product.id, 'sale', -v_quantity,
        'pos_sale', v_sale_id, 'Venta de mostrador', v_user_id
      );
    end if;
  end loop;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_sale.create', 'pos_sale', v_sale_id::text,
    jsonb_build_object(
      'total', v_total, 'discount_amount', p_discount_amount, 'surcharge_amount', p_surcharge_amount,
      'pos_shift_id', p_pos_shift_id, 'items', p_items, 'payments', p_payments
    )
  );

  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total);
end;
$$;

revoke all on function public.create_pos_sale(uuid, jsonb, jsonb, uuid, numeric, numeric, uuid) from public;
grant execute on function public.create_pos_sale(uuid, jsonb, jsonb, uuid, numeric, numeric, uuid) to authenticated;

-- Ojo: la firma vieja (6 argumentos, sin idempotency_key) se deja viva a
-- propósito -- alguien con una pestaña abierta en medio de un turno, con
-- el bundle viejo ya cargado en el navegador, todavía puede llamarla
-- hasta que recargue. Se puede borrar en una migración aparte más
-- adelante, una vez que dé confianza que nadie la sigue usando.
