create or replace function public.close_cash_session(
  p_branch_id uuid,
  p_closing_counted numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_session_id uuid;
  v_opening_amount numeric(14,2);
  v_opened_at timestamptz;
  v_opened_by uuid;
  v_cash_net numeric(14,2);
  v_expected numeric(14,2);
  v_difference numeric(14,2);
  v_closed_at timestamptz := now();
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

  if p_closing_counted is null or p_closing_counted < 0 then
    raise exception 'El monto contado no puede ser negativo';
  end if;

  select id, opening_amount, opened_at, opened_by
  into v_session_id, v_opening_amount, v_opened_at, v_opened_by
  from public.cash_sessions
  where branch_id = p_branch_id
    and company_id = v_company_id
    and status = 'open'
  for update;

  if v_session_id is null then
    raise exception 'No hay una caja abierta para esta sucursal';
  end if;

  select coalesce(sum(amount) filter (where direction = 'in' and payment_method = 'cash'), 0)
       - coalesce(sum(amount) filter (where direction = 'out' and payment_method = 'cash'), 0)
  into v_cash_net
  from public.cash_movements
  where cash_session_id = v_session_id;

  v_expected := v_opening_amount + v_cash_net;
  v_difference := p_closing_counted - v_expected;

  update public.cash_sessions
  set status = 'closed',
      closing_counted = p_closing_counted,
      difference = v_difference,
      closed_at = v_closed_at
  where id = v_session_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'cash_session.close', 'cash_session', v_session_id::text,
    jsonb_build_object('closing_counted', p_closing_counted, 'expected', v_expected, 'difference', v_difference)
  );

  return jsonb_build_object(
    'id', v_session_id,
    'branch_id', p_branch_id,
    'opening_amount', v_opening_amount,
    'opened_at', v_opened_at,
    'opened_by', v_opened_by,
    'status', 'closed',
    'closing_counted', p_closing_counted,
    'difference', v_difference,
    'closed_at', v_closed_at,
    'expected', v_expected
  );
end;
$$;

revoke all on function public.close_cash_session(uuid,numeric) from public;
grant execute on function public.close_cash_session(uuid,numeric) to authenticated;
