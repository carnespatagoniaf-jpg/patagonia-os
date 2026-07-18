alter table public.shift_sales drop constraint if exists shift_sales_shift_id_account_id_key;

drop function if exists public.save_shift_sale(uuid, uuid, numeric);

create or replace function public.save_shift_sale(
  p_sale_id uuid,
  p_shift_id uuid,
  p_account_id uuid,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_branch_id uuid;
  v_shift_date date;
  v_sale_id uuid;
  v_movement_id uuid;
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  select branch_id, shift_date into v_branch_id, v_shift_date
  from public.shift_registers
  where id = p_shift_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Turno inválido';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_sale_id is not null then
    select treasury_movement_id into v_movement_id
    from public.shift_sales
    where id = p_sale_id and shift_id = p_shift_id
    for update;

    if v_movement_id is null then
      raise exception 'Venta inválida';
    end if;

    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = v_shift_date
    where id = v_movement_id;

    update public.shift_sales
    set account_id = p_account_id, amount = p_amount
    where id = p_sale_id;

    v_sale_id := p_sale_id;
  else
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, shift_id, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'in', p_amount, 'venta',
      'shift', p_shift_id, v_shift_date, p_shift_id, v_user_id
    )
    returning id into v_movement_id;

    insert into public.shift_sales (shift_id, account_id, amount, treasury_movement_id)
    values (p_shift_id, p_account_id, p_amount, v_movement_id)
    returning id into v_sale_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_sale.save', 'shift_sale', v_sale_id::text,
    jsonb_build_object('shift_id', p_shift_id, 'account_id', p_account_id, 'amount', p_amount)
  );

  return jsonb_build_object('id', v_sale_id);
end;
$$;

revoke all on function public.save_shift_sale(uuid,uuid,uuid,numeric) from public;
grant execute on function public.save_shift_sale(uuid,uuid,uuid,numeric) to authenticated;

create or replace function public.delete_shift_sale(
  p_sale_id uuid
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
  v_shift_id uuid;
  v_branch_id uuid;
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

  select s.treasury_movement_id, s.shift_id, r.branch_id
  into v_movement_id, v_shift_id, v_branch_id
  from public.shift_sales s
  join public.shift_registers r on r.id = s.shift_id
  where s.id = p_sale_id and r.company_id = v_company_id
  for update of s;

  if v_shift_id is null then
    raise exception 'Venta inválida';
  end if;

  delete from public.shift_sales where id = p_sale_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_sale.delete', 'shift_sale', p_sale_id::text
  );

  return jsonb_build_object('id', p_sale_id);
end;
$$;

revoke all on function public.delete_shift_sale(uuid) from public;
grant execute on function public.delete_shift_sale(uuid) to authenticated;
