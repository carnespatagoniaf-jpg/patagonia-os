-- Decomisos para TODOS los planes (2026-10-23, decisión del dueño, igual que
-- los reportes en la 146). Las mismas funciones de la 151 sin el
-- require_plan('full'), y sin la política restrictiva plan_full de la tabla.

drop policy if exists plan_full on public.stock_wastes;

create or replace function public.register_stock_waste(
  p_branch_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_reason text,
  p_notes text default null,
  p_pos_shift_id uuid default null,
  p_barcode text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_product record;
  v_cashier uuid;
  v_id uuid;
begin
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000 then
    raise exception 'Cantidad inválida';
  end if;

  if p_reason is null or p_reason not in ('vencido', 'mal_estado', 'roto', 'otro') then
    raise exception 'Elegí el motivo del decomiso';
  end if;

  if p_reason = 'otro' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Contá qué pasó (motivo "Otro")';
  end if;

  select id, name, cost, unit into v_product
  from public.products
  where id = p_product_id and company_id = v_company_id
  for update;
  if not found then raise exception 'Producto inválido'; end if;

  if p_pos_shift_id is not null then
    select cashier_employee_id into v_cashier
    from public.pos_shifts
    where id = p_pos_shift_id and company_id = v_company_id and branch_id = p_branch_id and status = 'open';
    if not found then raise exception 'La caja no está abierta'; end if;
  end if;

  insert into public.stock_wastes (company_id, branch_id, product_id, quantity, unit_cost, reason, notes, barcode, pos_shift_id, cashier_employee_id, created_by)
  values (v_company_id, p_branch_id, p_product_id, round(p_quantity, 3), coalesce(v_product.cost, 0), p_reason,
    nullif(trim(coalesce(p_notes, '')), ''), nullif(trim(coalesce(p_barcode, '')), ''), p_pos_shift_id, v_cashier, v_user_id)
  returning id into v_id;

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, p_branch_id, p_product_id, 'waste', -round(p_quantity, 3), 'stock_waste', v_id,
    'Decomiso: ' || p_reason || coalesce(' · ' || nullif(trim(coalesce(p_notes, '')), ''), ''), v_user_id);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'stock_waste.create', 'stock_waste', v_id::text,
    jsonb_build_object('product_id', p_product_id, 'product', v_product.name, 'quantity', round(p_quantity, 3), 'reason', p_reason, 'unit_cost', coalesce(v_product.cost, 0)));

  return v_id;
end;
$$;

create or replace function public.void_stock_waste(p_waste_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_waste record;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  select * into v_waste from public.stock_wastes where id = p_waste_id and company_id = v_company_id for update;
  if not found then raise exception 'Decomiso inválido'; end if;
  if v_waste.voided_at is not null then return; end if;

  update public.stock_wastes set voided_at = now(), voided_by = v_user_id where id = p_waste_id;

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, v_waste.branch_id, v_waste.product_id, 'waste_void', v_waste.quantity, 'stock_waste_void', p_waste_id, 'Decomiso anulado', v_user_id);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_waste.branch_id, v_user_id, 'stock_waste.void', 'stock_waste', p_waste_id::text,
    jsonb_build_object('product_id', v_waste.product_id, 'quantity', v_waste.quantity));
end;
$$;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('152_stock_wastes_all_plans') on conflict do nothing;
