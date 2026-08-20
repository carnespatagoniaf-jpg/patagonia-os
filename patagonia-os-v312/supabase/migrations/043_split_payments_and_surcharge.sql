-- Inspirado en el sistema de mostrador real que ya usa el cliente (POS
-- tipo balanza/caja), suma varias cosas que le pasan "normal" a un
-- cajero:
-- 1) Pago dividido entre varias cuentas en un mismo ticket (ej. mitad
--    efectivo, mitad tarjeta). pos_sales.account_id queda en la tabla
--    sin usarse mas -- el detalle real de pago vive en
--    pos_sale_payments (uno o mas por venta), que es lo que
--    close_pos_shift agrupa para armar los movimientos de Tesoreria.
-- 2) Recargo total ademas del descuento que ya existia (ej. recargo por
--    pagar con tarjeta).
-- 3) Articulo manual: vender algo que no esta cargado como producto
--    (como "Art. Manual" en el sistema viejo) -- descripcion + precio a
--    mano, sin descontar stock de ningun producto.
-- 4) Anular una venta ya cobrada mientras el turno sigue abierto: revierte
--    el stock (movimiento inverso, no se borra nada) y la excluye del
--    cierre de turno. Si el turno ya cerro (ya se cargo a Tesoreria) no
--    se puede anular desde aca.
create table if not exists public.pos_sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.pos_sales(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id),
  amount numeric(14,2) not null check (amount > 0)
);

alter table public.pos_sale_payments enable row level security;

create policy "pos_sale_payments_company_isolation"
on public.pos_sale_payments for select
using (
  exists (
    select 1 from public.pos_sales s
    where s.id = pos_sale_payments.sale_id and s.company_id = public.current_company_id()
  )
);

alter table public.pos_sales
  alter column account_id drop not null,
  add column if not exists surcharge_amount numeric(14,2) not null default 0,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id);

alter table public.pos_sale_items
  alter column product_id drop not null,
  add column if not exists description text;

alter table public.pos_sale_items
  add constraint pos_sale_items_product_or_description
  check (product_id is not null or description is not null);

create or replace function public.create_pos_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_pos_shift_id uuid,
  p_discount_amount numeric default 0,
  p_surcharge_amount numeric default 0
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

  v_total := v_total - p_discount_amount + p_surcharge_amount;
  if v_total < 0 then
    raise exception 'El descuento supera el total de la venta';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    if not exists (
      select 1 from public.treasury_accounts
      where id = (v_payment->>'account_id')::uuid and company_id = v_company_id
    ) then
      raise exception 'Cuenta de tesorería inválida';
    end if;

    v_payment_amount := (v_payment->>'amount')::numeric;
    if v_payment_amount is null or v_payment_amount <= 0 then
      raise exception 'Monto de pago inválido';
    end if;

    v_payments_total := v_payments_total + v_payment_amount;
  end loop;

  if round(v_payments_total, 2) <> round(v_total, 2) then
    raise exception 'Los medios de pago no suman el total de la venta';
  end if;

  insert into public.pos_sales (id, company_id, branch_id, total, pos_shift_id, discount_amount, surcharge_amount, created_by)
  values (v_sale_id, v_company_id, p_branch_id, v_total, p_pos_shift_id, p_discount_amount, p_surcharge_amount, v_user_id);

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    insert into public.pos_sale_payments (sale_id, account_id, amount)
    values (v_sale_id, (v_payment->>'account_id')::uuid, (v_payment->>'amount')::numeric);
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

revoke all on function public.create_pos_sale(uuid, jsonb, jsonb, uuid, numeric, numeric) from public;
grant execute on function public.create_pos_sale(uuid, jsonb, jsonb, uuid, numeric, numeric) to authenticated;

drop function if exists public.create_pos_sale(uuid, jsonb, uuid, uuid, numeric);

create or replace function public.void_pos_sale(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale public.pos_sales%rowtype;
  v_shift public.pos_shifts%rowtype;
  v_item record;
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

  select * into v_sale
  from public.pos_sales
  where id = p_sale_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Venta inválida';
  end if;

  if v_sale.voided_at is not null then
    raise exception 'Esa venta ya está anulada';
  end if;

  select * into v_shift from public.pos_shifts where id = v_sale.pos_shift_id;

  if v_shift.status <> 'open' then
    raise exception 'No se puede anular: el turno ya está cerrado';
  end if;

  for v_item in
    select product_id, quantity from public.pos_sale_items
    where sale_id = p_sale_id and product_id is not null
  loop
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, v_sale.branch_id, v_item.product_id, 'sale_void', v_item.quantity,
      'pos_sale_void', p_sale_id, 'Anulación de venta de mostrador', v_user_id
    );
  end loop;

  update public.pos_sales
  set voided_at = now(), voided_by = v_user_id
  where id = p_sale_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_sale.branch_id, v_user_id, 'pos_sale.void', 'pos_sale', p_sale_id::text
  );
end;
$$;

revoke all on function public.void_pos_sale(uuid) from public;
grant execute on function public.void_pos_sale(uuid) to authenticated;

create or replace function public.close_pos_shift(p_pos_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift public.pos_shifts%rowtype;
  v_account record;
  v_summary jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
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

  select * into v_shift
  from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Turno inválido';
  end if;

  if v_shift.status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;

  for v_account in
    select psp.account_id, sum(psp.amount) as amount, count(distinct psp.sale_id) as sales_count
    from public.pos_sale_payments psp
    join public.pos_sales ps on ps.id = psp.sale_id
    where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null
    group by psp.account_id
  loop
    if v_account.amount > 0 then
      insert into public.treasury_movements (
        company_id, branch_id, account_id, direction, amount, movement_type,
        reference_type, reference_id, occurred_on, notes, created_by
      ) values (
        v_company_id, v_shift.branch_id, v_account.account_id, 'in', v_account.amount, 'venta',
        'pos_shift', p_pos_shift_id, current_date, 'Cierre de turno de mostrador', v_user_id
      );
    end if;
    v_total := v_total + v_account.amount;
    v_summary := v_summary || jsonb_build_object(
      'account_id', v_account.account_id,
      'amount', v_account.amount,
      'sales_count', v_account.sales_count
    );
  end loop;

  update public.pos_shifts
  set status = 'closed', closed_at = now(), closed_by = v_user_id
  where id = p_pos_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_shift.branch_id, v_user_id, 'pos_shift.close', 'pos_shift', p_pos_shift_id::text,
    jsonb_build_object('total', v_total, 'by_account', v_summary)
  );

  return jsonb_build_object('total', v_total, 'by_account', v_summary);
end;
$$;

revoke all on function public.close_pos_shift(uuid) from public;
grant execute on function public.close_pos_shift(uuid) to authenticated;
