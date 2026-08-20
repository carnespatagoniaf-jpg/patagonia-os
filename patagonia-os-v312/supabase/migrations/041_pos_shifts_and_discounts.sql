-- Mostrador pasa a ser un punto de venta profesional: las ventas se van
-- acumulando durante un "turno de mostrador" (pos_shifts) sin tocar
-- Tesorería en el momento -- recién al cerrar el turno se calcula el
-- total real por cuenta y ahí sí se escribe UN movimiento de
-- treasury_movements por cuenta usada, no uno por venta. Turnos (la carga
-- manual de shift_sales) sigue existiendo aparte, sin cambios -- esto no
-- los unifica, el cliente lo pidió así a propósito por ahora.
-- También se suma descuento por ítem y descuento total por venta.
create table if not exists public.pos_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  opened_by uuid not null references auth.users(id),
  closed_at timestamptz,
  closed_by uuid references auth.users(id)
);

-- Un solo turno abierto por sucursal a la vez.
create unique index if not exists pos_shifts_one_open_per_branch
  on public.pos_shifts (branch_id)
  where status = 'open';

alter table public.pos_shifts enable row level security;

create policy "pos_shifts_company_isolation"
on public.pos_shifts for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

alter table public.pos_sales
  add column if not exists pos_shift_id uuid references public.pos_shifts(id),
  add column if not exists discount_amount numeric(14,2) not null default 0;

alter table public.pos_sale_items
  add column if not exists discount_amount numeric(14,2) not null default 0;

create or replace function public.open_pos_shift(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_existing_id uuid;
  v_shift_id uuid;
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

  select id into v_existing_id
  from public.pos_shifts
  where branch_id = p_branch_id and status = 'open';

  if v_existing_id is not null then
    return jsonb_build_object('id', v_existing_id, 'already_open', true);
  end if;

  insert into public.pos_shifts (company_id, branch_id, opened_by)
  values (v_company_id, p_branch_id, v_user_id)
  returning id into v_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_shift.open', 'pos_shift', v_shift_id::text
  );

  return jsonb_build_object('id', v_shift_id, 'already_open', false);
end;
$$;

revoke all on function public.open_pos_shift(uuid) from public;
grant execute on function public.open_pos_shift(uuid) to authenticated;

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
    select account_id, sum(total) as amount, count(*) as sales_count
    from public.pos_sales
    where pos_shift_id = p_pos_shift_id
    group by account_id
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

create or replace function public.create_pos_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_account_id uuid,
  p_pos_shift_id uuid,
  p_discount_amount numeric default 0
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
  v_product public.products%rowtype;
  v_quantity numeric(14,3);
  v_unit_price numeric(14,2);
  v_stock numeric(14,3);
  v_item_discount numeric(14,2);
  v_line_total numeric(14,2);
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

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  if p_discount_amount is null or p_discount_amount < 0 then
    raise exception 'Descuento inválido';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid
      and company_id = v_company_id
      and active = true
    for update;

    if not found then
      raise exception 'Producto inválido';
    end if;

    v_quantity := (v_item->>'quantity')::numeric;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Cantidad inválida';
    end if;

    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    if v_item_discount < 0 then
      raise exception 'Descuento inválido';
    end if;

    select coalesce(sum(quantity), 0) into v_stock
    from public.inventory_movements
    where product_id = v_product.id and branch_id = p_branch_id;

    if v_stock < v_quantity then
      raise exception 'Stock insuficiente de %', v_product.name;
    end if;

    v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;
    if v_line_total < 0 then
      raise exception 'El descuento de % supera su precio', v_product.name;
    end if;

    v_total := v_total + v_line_total;
  end loop;

  v_total := v_total - p_discount_amount;
  if v_total < 0 then
    raise exception 'El descuento supera el total de la venta';
  end if;

  insert into public.pos_sales (id, company_id, branch_id, total, account_id, pos_shift_id, discount_amount, created_by)
  values (v_sale_id, v_company_id, p_branch_id, v_total, p_account_id, p_pos_shift_id, p_discount_amount, v_user_id);

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := v_product.price_retail;
    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);

    insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total)
    values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);

    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, p_branch_id, v_product.id, 'sale', -v_quantity,
      'pos_sale', v_sale_id, 'Venta de mostrador', v_user_id
    );
  end loop;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_sale.create', 'pos_sale', v_sale_id::text,
    jsonb_build_object('total', v_total, 'discount_amount', p_discount_amount, 'pos_shift_id', p_pos_shift_id, 'items', p_items)
  );

  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total);
end;
$$;

revoke all on function public.create_pos_sale(uuid, jsonb, uuid, uuid, numeric) from public;
grant execute on function public.create_pos_sale(uuid, jsonb, uuid, uuid, numeric) to authenticated;

drop function if exists public.create_pos_sale(uuid, jsonb, uuid);
