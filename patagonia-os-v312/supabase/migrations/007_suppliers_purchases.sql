create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  category text not null default 'general',
  phone text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id),
  purchase_date date not null,
  invoice_number text,
  total numeric(14,2) not null default 0,
  status text not null default 'active',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  product_id uuid references public.products(id),
  description text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit text not null check (unit in ('kg','unit')),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null,
  check (product_id is not null or description is not null)
);

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  payment_method text not null,
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.supplier_balance as
select
  s.id as supplier_id,
  s.company_id,
  coalesce(p.total_purchases, 0) as total_purchases,
  coalesce(pay.total_payments, 0) as total_payments,
  coalesce(p.total_purchases, 0) - coalesce(pay.total_payments, 0) as balance
from public.suppliers s
left join (
  select supplier_id, sum(total) as total_purchases
  from public.purchases
  where status = 'active'
  group by supplier_id
) p on p.supplier_id = s.id
left join (
  select supplier_id, sum(amount) as total_payments
  from public.supplier_payments
  group by supplier_id
) pay on pay.supplier_id = s.id;

alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.supplier_payments enable row level security;

create policy "suppliers_company_isolation"
on public.suppliers for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "purchases_company_isolation"
on public.purchases for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "purchase_items_company_isolation"
on public.purchase_items for all
using (
  exists (
    select 1 from public.purchases p
    where p.id = purchase_id and p.company_id = public.current_company_id()
  )
)
with check (
  exists (
    select 1 from public.purchases p
    where p.id = purchase_id and p.company_id = public.current_company_id()
  )
);

create policy "supplier_payments_company_isolation"
on public.supplier_payments for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

grant select on public.supplier_balance to authenticated;

create or replace function public.create_supplier(
  p_name text,
  p_category text,
  p_phone text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_supplier_id uuid := gen_random_uuid();
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre del proveedor es obligatorio';
  end if;

  insert into public.suppliers (id, company_id, name, category, phone, notes)
  values (v_supplier_id, v_company_id, trim(p_name), coalesce(nullif(trim(p_category), ''), 'general'), p_phone, p_notes);

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'supplier.create', 'supplier', v_supplier_id::text,
    jsonb_build_object('name', p_name, 'category', p_category)
  );

  return jsonb_build_object('id', v_supplier_id, 'name', trim(p_name), 'category', coalesce(nullif(trim(p_category), ''), 'general'));
end;
$$;

revoke all on function public.create_supplier(text,text,text,text) from public;
grant execute on function public.create_supplier(text,text,text,text) to authenticated;

create or replace function public.create_purchase_transaction(
  p_branch_id uuid,
  p_supplier_id uuid,
  p_purchase_date date,
  p_invoice_number text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_purchase_id uuid := gen_random_uuid();
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_product_id uuid;
  v_description text;
  v_quantity numeric(14,3);
  v_unit text;
  v_unit_price numeric(14,2);
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
    select 1 from public.suppliers
    where id = p_supplier_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_purchase_date is null then
    raise exception 'La fecha de compra es obligatoria';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'La compra no tiene ítems';
  end if;

  insert into public.purchases (
    id, company_id, branch_id, supplier_id, purchase_date, invoice_number, total, created_by
  ) values (
    v_purchase_id, v_company_id, p_branch_id, p_supplier_id, p_purchase_date, p_invoice_number, 0, v_user_id
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_description := nullif(v_item->>'description', '');
    v_quantity := (v_item->>'quantity')::numeric;
    v_unit := v_item->>'unit';
    v_unit_price := (v_item->>'unit_price')::numeric;

    if v_product_id is null and v_description is null then
      raise exception 'Cada ítem necesita un producto o una descripción';
    end if;

    if v_quantity <= 0 or v_unit_price < 0 then
      raise exception 'Cantidad o precio inválido';
    end if;

    if v_unit not in ('kg','unit') then
      raise exception 'Unidad inválida';
    end if;

    if v_product_id is not null and not exists (
      select 1 from public.products where id = v_product_id and company_id = v_company_id
    ) then
      raise exception 'Producto inválido';
    end if;

    v_line_total := v_quantity * v_unit_price;
    v_total := v_total + v_line_total;

    insert into public.purchase_items (
      purchase_id, product_id, description, quantity, unit, unit_price, line_total
    ) values (
      v_purchase_id, v_product_id, v_description, v_quantity, v_unit, v_unit_price, v_line_total
    );

    if v_product_id is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, p_branch_id, v_product_id, 'purchase', v_quantity,
        'purchase', v_purchase_id, 'Compra a proveedor', v_user_id
      );
    end if;
  end loop;

  update public.purchases set total = v_total where id = v_purchase_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'purchase.create', 'purchase', v_purchase_id::text,
    jsonb_build_object('total', v_total, 'supplier_id', p_supplier_id)
  );

  return jsonb_build_object('id', v_purchase_id, 'total', v_total);
end;
$$;

revoke all on function public.create_purchase_transaction(uuid,uuid,date,text,jsonb) from public;
grant execute on function public.create_purchase_transaction(uuid,uuid,date,text,jsonb) to authenticated;

create or replace function public.update_purchase_item(
  p_item_id uuid,
  p_quantity numeric,
  p_unit_price numeric
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
  v_branch_id uuid;
  v_product_id uuid;
  v_old_quantity numeric(14,3);
  v_delta numeric(14,3);
  v_new_line_total numeric(14,2);
  v_new_total numeric(14,2);
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

  if p_quantity <= 0 or p_unit_price < 0 then
    raise exception 'Cantidad o precio inválido';
  end if;

  select pi.purchase_id, pi.product_id, pi.quantity, p.branch_id
  into v_purchase_id, v_product_id, v_old_quantity, v_branch_id
  from public.purchase_items pi
  join public.purchases p on p.id = pi.purchase_id
  where pi.id = p_item_id and p.company_id = v_company_id
  for update of pi;

  if v_purchase_id is null then
    raise exception 'Ítem de compra inválido';
  end if;

  v_new_line_total := p_quantity * p_unit_price;
  v_delta := p_quantity - v_old_quantity;

  update public.purchase_items
  set quantity = p_quantity, unit_price = p_unit_price, line_total = v_new_line_total
  where id = p_item_id;

  if v_product_id is not null and v_delta <> 0 then
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, v_branch_id, v_product_id, 'purchase_adjustment', v_delta,
      'purchase', v_purchase_id, 'Corrección de compra', v_user_id
    );
  end if;

  select coalesce(sum(line_total), 0) into v_new_total
  from public.purchase_items
  where purchase_id = v_purchase_id;

  update public.purchases set total = v_new_total where id = v_purchase_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'purchase_item.update', 'purchase_item', p_item_id::text,
    jsonb_build_object('quantity', v_old_quantity),
    jsonb_build_object('quantity', p_quantity, 'unit_price', p_unit_price)
  );

  return jsonb_build_object('purchase_id', v_purchase_id, 'total', v_new_total);
end;
$$;

revoke all on function public.update_purchase_item(uuid,numeric,numeric) from public;
grant execute on function public.update_purchase_item(uuid,numeric,numeric) to authenticated;

create or replace function public.register_supplier_payment(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_payment_method text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_payment_id uuid := gen_random_uuid();
  v_cash_session_id uuid;
  v_balance numeric(14,2);
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
    select 1 from public.suppliers
    where id = p_supplier_id and company_id = v_company_id
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  insert into public.supplier_payments (
    id, company_id, branch_id, supplier_id, payment_date, amount, payment_method, notes, created_by
  ) values (
    v_payment_id, v_company_id, p_branch_id, p_supplier_id, p_payment_date, p_amount, p_payment_method, p_notes, v_user_id
  );

  if p_payment_method = 'cash' then
    select id into v_cash_session_id
    from public.cash_sessions
    where branch_id = p_branch_id and company_id = v_company_id and status = 'open'
    for update;

    if v_cash_session_id is not null then
      insert into public.cash_movements (
        company_id, branch_id, cash_session_id, direction, payment_method,
        amount, movement_type, reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, p_branch_id, v_cash_session_id, 'out', 'cash',
        p_amount, 'pago_proveedor', 'supplier_payment', v_payment_id, coalesce(p_notes, 'Pago a proveedor'), v_user_id
      );
    end if;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'supplier_payment.create', 'supplier_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'payment_method', p_payment_method, 'supplier_id', p_supplier_id)
  );

  select balance into v_balance from public.supplier_balance where supplier_id = p_supplier_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_supplier_payment(uuid,uuid,date,numeric,text,text) from public;
grant execute on function public.register_supplier_payment(uuid,uuid,date,numeric,text,text) to authenticated;
