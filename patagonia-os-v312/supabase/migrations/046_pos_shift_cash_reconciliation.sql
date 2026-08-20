-- Arqueo de caja para Mostrador -- mismo control que ya tenia Turnos
-- (shift_registers.closing_counted_cash, 008_treasury_and_shifts.sql): al
-- abrir el turno de mostrador se puede declarar el fondo inicial, y al
-- cerrarlo se cuenta el efectivo fisico. El servidor calcula el efectivo
-- esperado (fondo inicial + ventas en efectivo de ese turno, sin contar
-- las anuladas) y devuelve la diferencia -- asi si un cajero cobra con
-- tarjeta pero marca "Efectivo" por error, o falta/sobra plata, queda
-- registrado en el cierre en vez de perderse.
alter table public.pos_shifts
  add column if not exists opening_cash numeric(14,2) not null default 0,
  add column if not exists closing_counted_cash numeric(14,2);

create or replace function public.open_pos_shift(p_branch_id uuid, p_opening_cash numeric default 0)
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

  if p_opening_cash is not null and p_opening_cash < 0 then
    raise exception 'El fondo inicial no puede ser negativo';
  end if;

  select id into v_existing_id
  from public.pos_shifts
  where branch_id = p_branch_id and status = 'open';

  if v_existing_id is not null then
    return jsonb_build_object('id', v_existing_id, 'already_open', true);
  end if;

  insert into public.pos_shifts (company_id, branch_id, opened_by, opening_cash)
  values (v_company_id, p_branch_id, v_user_id, coalesce(p_opening_cash, 0))
  returning id into v_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_shift.open', 'pos_shift', v_shift_id::text,
    jsonb_build_object('opening_cash', coalesce(p_opening_cash, 0))
  );

  return jsonb_build_object('id', v_shift_id, 'already_open', false);
end;
$$;

revoke all on function public.open_pos_shift(uuid, numeric) from public;
grant execute on function public.open_pos_shift(uuid, numeric) to authenticated;

drop function if exists public.open_pos_shift(uuid);

create or replace function public.close_pos_shift(p_pos_shift_id uuid, p_closing_counted_cash numeric default null)
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
  v_cash_sales numeric(14,2) := 0;
  v_expected_cash numeric(14,2);
  v_difference numeric(14,2);
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

  select coalesce(sum(psp.amount), 0) into v_cash_sales
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.treasury_accounts ta on ta.id = psp.account_id
  where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null and ta.payment_method = 'cash';

  v_expected_cash := coalesce(v_shift.opening_cash, 0) + v_cash_sales;
  v_difference := case when p_closing_counted_cash is null then null else p_closing_counted_cash - v_expected_cash end;

  update public.pos_shifts
  set status = 'closed', closed_at = now(), closed_by = v_user_id, closing_counted_cash = p_closing_counted_cash
  where id = p_pos_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_shift.branch_id, v_user_id, 'pos_shift.close', 'pos_shift', p_pos_shift_id::text,
    jsonb_build_object(
      'total', v_total, 'by_account', v_summary, 'opening_cash', v_shift.opening_cash,
      'expected_cash', v_expected_cash, 'counted_cash', p_closing_counted_cash, 'difference', v_difference
    )
  );

  return jsonb_build_object(
    'total', v_total, 'by_account', v_summary,
    'expected_cash', v_expected_cash, 'counted_cash', p_closing_counted_cash, 'difference', v_difference
  );
end;
$$;

revoke all on function public.close_pos_shift(uuid, numeric) from public;
grant execute on function public.close_pos_shift(uuid, numeric) to authenticated;

drop function if exists public.close_pos_shift(uuid);
