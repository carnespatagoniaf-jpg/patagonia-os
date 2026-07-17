create or replace function public.open_cash_session(
  p_branch_id uuid,
  p_opening_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_session_id uuid := gen_random_uuid();
  v_existing_id uuid;
  v_opened_at timestamptz := now();
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

  if p_opening_amount is null or p_opening_amount < 0 then
    raise exception 'El monto inicial no puede ser negativo';
  end if;

  select id into v_existing_id
  from public.cash_sessions
  where branch_id = p_branch_id
    and company_id = v_company_id
    and status = 'open'
  for update;

  if v_existing_id is not null then
    raise exception 'Ya hay una caja abierta para esta sucursal';
  end if;

  insert into public.cash_sessions (
    id, company_id, branch_id, opened_by, status, opening_amount, opened_at
  ) values (
    v_session_id, v_company_id, p_branch_id, v_user_id, 'open', p_opening_amount, v_opened_at
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'cash_session.open', 'cash_session', v_session_id::text,
    jsonb_build_object('opening_amount', p_opening_amount)
  );

  return jsonb_build_object(
    'id', v_session_id,
    'branch_id', p_branch_id,
    'opening_amount', p_opening_amount,
    'opened_at', v_opened_at,
    'opened_by', v_user_id,
    'status', 'open'
  );
end;
$$;

revoke all on function public.open_cash_session(uuid,numeric) from public;
grant execute on function public.open_cash_session(uuid,numeric) to authenticated;
