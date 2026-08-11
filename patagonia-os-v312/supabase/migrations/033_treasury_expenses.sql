-- Punto 2 pedido por el dueño de Carnes Patagonia: los gastos reales de la
-- "caja grande" (ej. arreglo de un motor) se estaban forzando como "Ajustar
-- cuenta" — funciona para el saldo, pero queda mezclado con correcciones de
-- caja, sin categoría ni forma de distinguirlo después. Se agrega un
-- concepto propio de "Gasto" (movement_type='gasto', igual que los gastos
-- que ya se cargan desde un turno vía shift_outflows) con categoría, para
-- que se pueda registrar sin necesidad de un turno abierto.

alter table public.treasury_movements
  add column if not exists category text;

create or replace function public.register_treasury_expense(
  p_branch_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_category text,
  p_description text,
  p_expense_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
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
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_category not in ('mantenimiento', 'servicios', 'impuestos', 'insumos', 'otro') then
    raise exception 'Categoría inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'La descripción es obligatoria';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    category, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, 'out', p_amount, 'gasto',
    p_category, coalesce(p_expense_date, current_date), trim(p_description), v_user_id
  )
  returning id into v_movement_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'treasury_expense.create', 'treasury_movement', v_movement_id::text,
    jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'category', p_category, 'description', p_description)
  );

  select balance into v_balance from public.treasury_balance where account_id = p_account_id;

  return jsonb_build_object('id', v_movement_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_treasury_expense(uuid,uuid,numeric,text,text,date) from public;
grant execute on function public.register_treasury_expense(uuid,uuid,numeric,text,text,date) to authenticated;

create or replace function public.delete_treasury_expense(p_movement_id uuid)
returns jsonb
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
    select 1 from public.treasury_movements
    where id = p_movement_id and company_id = v_company_id and movement_type = 'gasto'
  ) then
    raise exception 'Gasto inválido';
  end if;

  delete from public.treasury_movements where id = p_movement_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'treasury_expense.delete', 'treasury_movement', p_movement_id::text
  );

  return jsonb_build_object('id', p_movement_id);
end;
$$;

revoke all on function public.delete_treasury_expense(uuid) from public;
grant execute on function public.delete_treasury_expense(uuid) to authenticated;
