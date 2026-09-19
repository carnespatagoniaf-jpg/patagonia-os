-- Pedido real: la caja de la noche parecía dar -$165.606 en efectivo. El
-- arqueo del sistema estaba bien (-$210); el número salía de comparar las
-- ventas en efectivo ($820.606) contra lo contado en la caja fuerte
-- ($655.000) sin descontar los vales ($113.896) ni el pago a Santiago
-- ($51.500), que también salieron de esa plata.
--
-- Esta versión hace lo mismo que la de 065 (el cálculo del efectivo
-- esperado no cambia) pero además DEVUELVE el desglose -- fondo inicial,
-- ventas en efectivo, salidas y entradas en efectivo, total de vales y de
-- pagos a proveedores -- y cuánto se sacó del turno contra cuentas que NO
-- son efectivo (esas no se restan del esperado), para que el cierre pueda
-- mostrar de dónde sale cada número.
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
  v_cash_movements numeric(14,2) := 0;
  v_cash_outflows numeric(14,2) := 0;
  v_cash_inflows numeric(14,2) := 0;
  v_cash_vales numeric(14,2) := 0;
  v_cash_supplier numeric(14,2) := 0;
  v_noncash_outflows numeric(14,2) := 0;
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

  select
    coalesce(sum(case when tm.direction = 'in' then tm.amount else -tm.amount end), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out'), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'in'), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out' and tm.movement_type in ('vale_adelanto', 'vale_mercaderia')), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out' and tm.movement_type = 'pago_proveedor'), 0)
  into v_cash_movements, v_cash_outflows, v_cash_inflows, v_cash_vales, v_cash_supplier
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method = 'cash'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  select coalesce(sum(tm.amount), 0) into v_noncash_outflows
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method is distinct from 'cash'
    and tm.direction = 'out'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  v_expected_cash := coalesce(v_shift.opening_cash, 0) + v_cash_sales + v_cash_movements;
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
      'cash_sales', v_cash_sales, 'cash_movements', v_cash_movements,
      'cash_outflows', v_cash_outflows, 'cash_inflows', v_cash_inflows,
      'noncash_outflows', v_noncash_outflows, 'expected_cash', v_expected_cash,
      'counted_cash', p_closing_counted_cash, 'difference', v_difference
    )
  );

  return jsonb_build_object(
    'total', v_total, 'by_account', v_summary,
    'opening_cash', coalesce(v_shift.opening_cash, 0), 'cash_sales', v_cash_sales,
    'cash_outflows', v_cash_outflows, 'cash_inflows', v_cash_inflows,
    'cash_vales', v_cash_vales, 'cash_supplier_payments', v_cash_supplier,
    'noncash_outflows', v_noncash_outflows,
    'expected_cash', v_expected_cash, 'counted_cash', p_closing_counted_cash, 'difference', v_difference
  );
end;
$$;

revoke all on function public.close_pos_shift(uuid, numeric) from public;
grant execute on function public.close_pos_shift(uuid, numeric) to authenticated;
