-- Las entregas a clientes de cuenta corriente (customer_charges,
-- 048_customers.sql) hasta ahora eran monto + un texto libre -- no
-- alcanzaba para armar un remito real con lo que efectivamente se le
-- entregó. Se agrega el detalle por producto (customer_charge_items,
-- espejo de pos_sale_items) y una nueva forma de cargar la entrega que
-- SÍ descuenta stock -- a diferencia de las entregas viejas (monto+texto,
-- que a propósito no tocaban stock), acá se le está entregando mercadería
-- real de la sucursal, igual que en una venta de Mostrador.
create table if not exists public.customer_charge_items (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.customer_charges(id) on delete cascade,
  product_id uuid references public.products(id),
  description text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null,
  created_at timestamptz not null default now()
);

alter table public.customer_charge_items enable row level security;

-- No tiene company_id propio -- se filtra a través del cargo (que sí lo
-- tiene), mismo patrón que pos_sale_items con pos_sales.
create policy "customer_charge_items_company_isolation"
on public.customer_charge_items for all
using (
  exists (
    select 1 from public.customer_charges cc
    where cc.id = customer_charge_items.charge_id and cc.company_id = public.current_company_id()
  )
)
with check (
  exists (
    select 1 from public.customer_charges cc
    where cc.id = customer_charge_items.charge_id and cc.company_id = public.current_company_id()
  )
);

create or replace function public.create_customer_charge_with_items(
  p_customer_id uuid,
  p_branch_id uuid,
  p_charge_date date,
  p_items jsonb,
  p_reason text default null
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
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id
  ) then
    raise exception 'Cliente inválido';
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

  v_total := round(v_total);
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
    jsonb_build_object('amount', v_total, 'customer_id', p_customer_id, 'items', p_items)
  );

  return jsonb_build_object('id', v_charge_id, 'amount', v_total);
end;
$$;

revoke all on function public.create_customer_charge_with_items(uuid,uuid,date,jsonb,text) from public;
grant execute on function public.create_customer_charge_with_items(uuid,uuid,date,jsonb,text) to authenticated;

-- Detalle de items para el remito impreso -- espejo de listPosShiftSales,
-- pero de un solo cargo (no hace falta listar muchos a la vez).
create or replace function public.get_customer_charge_items(p_charge_id uuid)
returns table (
  id uuid,
  product_name text,
  description text,
  quantity numeric,
  unit_price numeric,
  line_total numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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
    select 1 from public.customer_charges cc
    where cc.id = p_charge_id and cc.company_id = v_company_id
  ) then
    raise exception 'Cargo inválido';
  end if;

  return query
  select
    cci.id,
    coalesce(p.name, cci.description) as product_name,
    cci.description,
    cci.quantity,
    cci.unit_price,
    cci.line_total
  from public.customer_charge_items cci
  left join public.products p on p.id = cci.product_id
  where cci.charge_id = p_charge_id
  order by cci.created_at;
end;
$$;

revoke all on function public.get_customer_charge_items(uuid) from public;
grant execute on function public.get_customer_charge_items(uuid) to authenticated;
