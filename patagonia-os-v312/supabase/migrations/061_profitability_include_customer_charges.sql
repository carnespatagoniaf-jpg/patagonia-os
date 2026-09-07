-- Las entregas a clientes de cuenta corriente (customer_charges,
-- 048_customers.sql / 060_customer_charge_items.sql) descuentan stock real
-- igual que una venta, pero hasta ahora el cierre de Rentabilidad no las
-- sumaba a v_sales_total (solo sumaba shift_sales de Turnos) -- el dueño
-- pidió que sí cuenten como venta real (el cobro sigue siendo un evento
-- aparte en Tesorería, eso no cambia). customer_charges no tiene branch_id
-- propio, se filtra por la sucursal del cliente (customers.branch_id),
-- mismo patrón que listCustomerChargesInRange en el frontend.
create or replace function public.close_profitability_period(
  p_branch_id uuid,
  p_period_start date,
  p_period_end date,
  p_stock_start numeric,
  p_stock_end numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sales_total numeric(14,2);
  v_customer_charges_total numeric(14,2);
  v_purchases_total numeric(14,2);
  v_fixed_costs_monthly numeric(14,2);
  v_fixed_costs_total numeric(14,2);
  v_days integer;
  v_gross_profit numeric(14,2);
  v_period_id uuid;
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

  if p_period_end < p_period_start then
    raise exception 'El rango de fechas es inválido';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if exists (
    select 1 from public.profitability_periods
    where branch_id = p_branch_id
      and period_start <= p_period_end
      and period_end >= p_period_start
  ) then
    raise exception 'Ya existe un cierre que se superpone con ese período';
  end if;

  select coalesce(sum(ss.amount), 0) into v_sales_total
  from public.shift_sales ss
  join public.shift_registers sr on sr.id = ss.shift_id
  where sr.branch_id = p_branch_id and sr.company_id = v_company_id
    and sr.shift_date between p_period_start and p_period_end;

  select coalesce(sum(cc.amount), 0) into v_customer_charges_total
  from public.customer_charges cc
  join public.customers c on c.id = cc.customer_id
  where c.branch_id = p_branch_id and cc.company_id = v_company_id
    and cc.charge_date between p_period_start and p_period_end;

  v_sales_total := v_sales_total + v_customer_charges_total;

  select coalesce(sum(total), 0) into v_purchases_total
  from public.purchases
  where branch_id = p_branch_id and company_id = v_company_id and status = 'active'
    and purchase_date between p_period_start and p_period_end;

  select coalesce(sum(monthly_amount), 0) into v_fixed_costs_monthly
  from public.fixed_costs
  where branch_id = p_branch_id and company_id = v_company_id and active = true;

  v_days := (p_period_end - p_period_start) + 1;
  v_fixed_costs_total := round(v_fixed_costs_monthly / 30.0 * v_days, 2);

  v_gross_profit := v_sales_total - (coalesce(p_stock_start, 0) + v_purchases_total - coalesce(p_stock_end, 0)) - v_fixed_costs_total;

  insert into public.profitability_periods (
    company_id, branch_id, period_start, period_end,
    sales_total, purchases_total, fixed_costs_total, stock_start, stock_end, gross_profit, created_by
  ) values (
    v_company_id, p_branch_id, p_period_start, p_period_end,
    v_sales_total, v_purchases_total, v_fixed_costs_total, coalesce(p_stock_start, 0), coalesce(p_stock_end, 0), v_gross_profit, v_user_id
  )
  returning id into v_period_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'profitability_period.close', 'profitability_period', v_period_id::text,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'gross_profit', v_gross_profit)
  );

  return jsonb_build_object(
    'id', v_period_id,
    'sales_total', v_sales_total,
    'purchases_total', v_purchases_total,
    'fixed_costs_total', v_fixed_costs_total,
    'stock_start', coalesce(p_stock_start, 0),
    'stock_end', coalesce(p_stock_end, 0),
    'gross_profit', v_gross_profit
  );
end;
$$;

revoke all on function public.close_profitability_period(uuid,date,date,numeric,numeric) from public;
grant execute on function public.close_profitability_period(uuid,date,date,numeric,numeric) to authenticated;
