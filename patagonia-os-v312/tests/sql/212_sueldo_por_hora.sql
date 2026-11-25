-- Pruebas de la migración 212 (sueldo por hora). Se deshace al final.
-- $5.000 la hora + premio fijo $500 la hora, 37,5 horas en la semana, un vale de $10.000 → sueldo $206.250, neto
-- $196.250, pagado desde Efectivo. Sin horas, o con más horas que las del período, no liquida. Un empleado por día
-- sigue igual sin mandar horas.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c2121', 'Por hora', 9212, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c2122', '00000000-0000-0000-0000-0000000c2121', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c2123', 'duenia@porhora');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c2123', '00000000-0000-0000-0000-0000000c2121', '00000000-0000-0000-0000-0000000c2122', 'Dueña', 'admin');
insert into treasury_accounts (id, company_id, name, payment_method) values
  ('00000000-0000-0000-0000-0000000c2124', '00000000-0000-0000-0000-0000000c2121', 'Efectivo', 'cash');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2123', true);
set local role authenticated;

do $$
declare
  v_hourly uuid;
  v_daily uuid;
  r jsonb;
begin
  v_hourly := (public.create_employee('00000000-0000-0000-0000-0000000c2122', 'Kiara', 5000, 'hourly', 500, 'Presentismo')->>'id')::uuid;
  v_daily := (public.create_employee('00000000-0000-0000-0000-0000000c2122', 'Martín', 48000, 'daily')->>'id')::uuid;

  perform public.create_payroll_adjustment(v_hourly, '2026-11-18', 'deduction', 10000, 'Vale');

  -- Sin horas no liquida.
  begin
    perform public.close_payroll_liquidation('00000000-0000-0000-0000-0000000c2122', v_hourly, '2026-11-16', '2026-11-22');
    raise exception 'liquidó por hora sin horas';
  exception when raise_exception then
    if sqlerrm <> 'Cargá las horas que trabajó en el período' then raise; end if;
  end;

  -- Más horas que las del período (7 días = 168 h): no.
  begin
    perform public.close_payroll_liquidation('00000000-0000-0000-0000-0000000c2122', v_hourly, '2026-11-16', '2026-11-22', '[]'::jsonb, 169);
    raise exception 'aceptó más horas que las del período';
  exception when raise_exception then
    if sqlerrm <> 'Son más horas que las que tiene el período' then raise; end if;
  end;

  r := public.close_payroll_liquidation('00000000-0000-0000-0000-0000000c2122', v_hourly, '2026-11-16', '2026-11-22',
    jsonb_build_array(jsonb_build_object('account_id', '00000000-0000-0000-0000-0000000c2124', 'amount', 196250)), 37.5);
  if (r->>'base_salary')::numeric <> 206250 then raise exception 'sueldo por hora: %', r; end if;
  if (r->>'net_amount')::numeric <> 196250 then raise exception 'neto por hora: %', r; end if;
  if (r->>'hours_worked')::numeric <> 37.5 then raise exception 'no devolvió las horas: %', r; end if;
  if (select hours_worked from payroll_liquidations where id = (r->>'id')::uuid) <> 37.5 then
    raise exception 'no guardó las horas';
  end if;

  -- Por día, sin mandar horas: como siempre (7 días × $48.000), y no guarda horas.
  r := public.close_payroll_liquidation('00000000-0000-0000-0000-0000000c2122', v_daily, '2026-11-16', '2026-11-22');
  if (r->>'base_salary')::numeric <> 336000 then raise exception 'sueldo por día cambió: %', r; end if;
  if (select hours_worked from payroll_liquidations where id = (r->>'id')::uuid) is not null then
    raise exception 'guardó horas a uno que cobra por día';
  end if;

  -- Un período inventado sigue rechazado.
  begin
    perform public.update_employee(v_daily, 'Martín', 48000, true, 'por_minuto');
    raise exception 'aceptó un período inventado';
  exception when raise_exception then
    if sqlerrm = 'aceptó un período inventado' then raise; end if;
  end;
end $$;

rollback;
