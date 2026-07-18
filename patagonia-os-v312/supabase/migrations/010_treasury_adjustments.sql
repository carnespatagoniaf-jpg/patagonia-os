create or replace function public.adjust_treasury_account(
  p_account_id uuid,
  p_branch_id uuid,
  p_amount numeric,
  p_direction text,
  p_reason text
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

  if p_direction not in ('in','out') then
    raise exception 'Dirección inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, p_direction, p_amount, 'ajuste',
    current_date, trim(p_reason), v_user_id
  )
  returning id into v_movement_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'treasury_account.adjust', 'treasury_movement', v_movement_id::text,
    jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'direction', p_direction, 'reason', p_reason)
  );

  select balance into v_balance from public.treasury_balance where account_id = p_account_id;

  return jsonb_build_object('id', v_movement_id, 'balance', v_balance);
end;
$$;

revoke all on function public.adjust_treasury_account(uuid,uuid,numeric,text,text) from public;
grant execute on function public.adjust_treasury_account(uuid,uuid,numeric,text,text) to authenticated;

create or replace function public.transfer_treasury_funds(
  p_branch_id uuid,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
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
  v_transfer_id uuid := gen_random_uuid();
  v_out_id uuid;
  v_in_id uuid;
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

  if p_from_account_id = p_to_account_id then
    raise exception 'Elegí dos cuentas distintas';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_from_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de origen inválida';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_to_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de destino inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_from_account_id, 'out', p_amount, 'transferencia',
    'transfer', v_transfer_id, current_date, coalesce(p_reason, 'Transferencia entre cuentas'), v_user_id
  )
  returning id into v_out_id;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_to_account_id, 'in', p_amount, 'transferencia',
    'transfer', v_transfer_id, current_date, coalesce(p_reason, 'Transferencia entre cuentas'), v_user_id
  )
  returning id into v_in_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'treasury.transfer', 'treasury_transfer', v_transfer_id::text,
    jsonb_build_object('from_account_id', p_from_account_id, 'to_account_id', p_to_account_id, 'amount', p_amount, 'reason', p_reason)
  );

  return jsonb_build_object('transfer_id', v_transfer_id, 'out_movement_id', v_out_id, 'in_movement_id', v_in_id);
end;
$$;

revoke all on function public.transfer_treasury_funds(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.transfer_treasury_funds(uuid,uuid,uuid,numeric,text) to authenticated;
