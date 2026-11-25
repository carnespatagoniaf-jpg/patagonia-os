-- 212: Sueldo por hora. Pedido de Jp24 Premium (25/11/2026): sus empleados cobran por hora y las horas cambian
-- cada semana, así que no alcanza con "por día".
--
-- employees.salary_period suma 'hourly': base_salary es el valor de la hora. No hay fichaje en el sistema, así
-- que las horas se cargan al liquidar: close_payroll_liquidation recibe p_hours (nuevo, al final, con default
-- null, así una pestaña vieja que no lo manda sigue andando para los demás períodos) y el sueldo del período es
-- (valor de la hora + premio fijo) × horas, igual que los otros períodos suman el premio fijo a la base.
-- Las horas quedan en payroll_liquidations.hours_worked para el recibo.
--
-- Las tres funciones se inyectan sobre la definición viva (prod tiene require_plan y los vales de Mostrador,
-- que no están en el texto de la 054), y si algún pedazo no aparece se corta todo.

alter table public.payroll_liquidations
  add column if not exists hours_worked numeric(8,2);

alter table public.employees drop constraint if exists employees_salary_period_check;
alter table public.employees
  add constraint employees_salary_period_check check (salary_period in ('daily', 'weekly', 'biweekly', 'monthly', 'hourly'));

do $mig$
declare
  v_fn text;
  v_def text;
  v_new text;
begin
  -- Alta y edición de empleado: aceptar 'hourly'.
  foreach v_fn in array array[
    'public.create_employee(uuid,text,numeric,text,numeric,text)',
    'public.update_employee(uuid,text,numeric,boolean,text,numeric,text)'
  ] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    if position('''hourly''' in v_def) > 0 then continue; end if;
    v_new := replace(v_def, '(''daily'', ''weekly'', ''biweekly'', ''monthly'')', '(''daily'', ''weekly'', ''biweekly'', ''monthly'', ''hourly'')');
    if v_new = v_def then raise exception '% no tiene la lista de períodos esperada', v_fn; end if;
    execute v_new;
  end loop;

  -- Liquidación: horas trabajadas.
  if to_regprocedure('public.close_payroll_liquidation(uuid,uuid,date,date,jsonb,numeric)') is not null then return; end if;
  v_def := pg_get_functiondef('public.close_payroll_liquidation(uuid,uuid,date,date,jsonb)'::regprocedure);

  v_new := regexp_replace(v_def, '(p_payments jsonb DEFAULT ''\[\]''::jsonb)\)', '\1, p_hours numeric DEFAULT NULL::numeric)');
  if v_new = v_def then raise exception 'close_payroll_liquidation: no se encontró la firma'; end if;
  v_def := v_new;

  v_new := replace(v_def,
    'v_prorated_base := round((v_base_salary + v_recurring_bonus_amount) * v_period_days / v_divisor, 2);',
    $rep$if v_salary_period = 'hourly' then
    if p_hours is null or p_hours <= 0 then
      raise exception 'Cargá las horas que trabajó en el período';
    end if;
    if p_hours > v_period_days * 24 then
      raise exception 'Son más horas que las que tiene el período';
    end if;
    v_prorated_base := round((v_base_salary + v_recurring_bonus_amount) * p_hours, 2);
  else
    v_prorated_base := round((v_base_salary + v_recurring_bonus_amount) * v_period_days / v_divisor, 2);
  end if;$rep$);
  if v_new = v_def then raise exception 'close_payroll_liquidation: no se encontró el cálculo del sueldo'; end if;
  v_def := v_new;

  v_new := regexp_replace(v_def,
    '(base_salary, adjustments_total, vouchers_total, net_amount,\s*created_by)(\s*\)\s*values\s*\()',
    '\1, hours_worked\2');
  if v_new = v_def then raise exception 'close_payroll_liquidation: no se encontró el insert (columnas)'; end if;
  v_def := v_new;

  v_new := regexp_replace(v_def,
    '(v_prorated_base, v_adjustments_total, v_vouchers_total, v_net_amount,\s*v_user_id)(\s*\)\s*returning id into v_liquidation_id)',
    '\1, case when v_salary_period = ''hourly'' then p_hours end\2');
  if v_new = v_def then raise exception 'close_payroll_liquidation: no se encontró el insert (valores)'; end if;
  v_def := v_new;

  v_new := replace(v_def, '''base_salary'', v_prorated_base,',
    '''base_salary'', v_prorated_base,
    ''hours_worked'', case when v_salary_period = ''hourly'' then p_hours end,');
  if v_new = v_def then raise exception 'close_payroll_liquidation: no se encontró el resultado'; end if;
  v_def := v_new;

  execute v_def;
  drop function public.close_payroll_liquidation(uuid,uuid,date,date,jsonb);
end
$mig$;

revoke all on function public.close_payroll_liquidation(uuid,uuid,date,date,jsonb,numeric) from public, anon;
grant execute on function public.close_payroll_liquidation(uuid,uuid,date,date,jsonb,numeric) to authenticated;

insert into public.schema_migrations (version) values ('212_sueldo_por_hora') on conflict do nothing;
