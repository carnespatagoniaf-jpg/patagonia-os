-- 172: "Inicio de caja" con el nombre de quien atiende (pedido del dueño, 2026-10-29).
--
-- Las carnicerías sin PIN de caja (Empleados → "PIN de caja") abrían el turno sin nombre: en Control de caja
-- y en Reportes aparecía el usuario de la PC (muchas veces el del dueño, compartido). Ahora, al abrir la caja,
-- se puede escribir el nombre de la persona. Es opcional y solo se usa cuando NO hay cajera con PIN (la del
-- PIN sigue mandando, porque está comprobada).
--
-- 1. pos_shifts.cashier_name (texto libre, hasta 60 letras).
-- 2. open_pos_shift: 5.º argumento p_cashier_name (con default, así una pestaña vieja que manda 2 o 4 sigue
--    andando). Se borra la de 4 para que no haya dos versiones que PostgREST no sepa elegir.
-- 3. list_pos_shift_closes (Control de caja) y sales_activity_report (Reportes → por cajero) muestran ese nombre
--    antes que el usuario de la PC. En sales_activity_report se inyecta sobre la definición viva.
-- No cambia ningún dato existente.

alter table public.pos_shifts add column if not exists cashier_name text;
do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_shifts_cashier_name_len') then
    alter table public.pos_shifts add constraint pos_shifts_cashier_name_len check (cashier_name is null or length(cashier_name) <= 60);
  end if;
end
$mig$;

drop function if exists public.open_pos_shift(uuid, numeric, uuid, text);

create or replace function public.open_pos_shift(
  p_branch_id uuid,
  p_opening_cash numeric default 0,
  p_cashier_employee_id uuid default null,
  p_cashier_pin text default null,
  p_cashier_name text default null
)
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
  v_cashier uuid;
  v_name text := nullif(left(btrim(regexp_replace(coalesce(p_cashier_name, ''), '\s+', ' ', 'g')), 60), '');
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

  if public.pos_cashier_required(v_company_id, p_branch_id) then
    v_cashier := public.pos_verify_cashier(v_company_id, p_branch_id, p_cashier_employee_id, p_cashier_pin);
  end if;
  -- La cajera con PIN ya tiene nombre (Empleados): el texto libre es solo para cuando no hay PIN.
  if v_cashier is not null then v_name := null; end if;

  insert into public.pos_shifts (company_id, branch_id, opened_by, opening_cash, cashier_employee_id, cashier_name)
  values (v_company_id, p_branch_id, v_user_id, coalesce(p_opening_cash, 0), v_cashier, v_name)
  returning id into v_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_shift.open', 'pos_shift', v_shift_id::text,
    jsonb_build_object('opening_cash', coalesce(p_opening_cash, 0), 'cashier_employee_id', v_cashier, 'cashier_name', v_name)
  );

  return jsonb_build_object('id', v_shift_id, 'already_open', false, 'cashier_employee_id', v_cashier, 'cashier_name', v_name);
end;
$$;
revoke all on function public.open_pos_shift(uuid, numeric, uuid, text, text) from public, anon;
grant execute on function public.open_pos_shift(uuid, numeric, uuid, text, text) to authenticated;

create or replace function public.list_pos_shift_closes(p_branch_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_result jsonb;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.opened_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      s.id, s.opened_at, s.closed_at, s.status,
      coalesce(e.full_name, nullif(s.cashier_name, ''), po.full_name) as cashier_name,
      (s.cashier_employee_id is not null) as cashier_with_pin,
      (a.new_data ->> 'expected_cash')::numeric as expected_cash,
      (a.new_data ->> 'counted_cash')::numeric as counted_cash,
      (a.new_data ->> 'difference')::numeric as difference,
      (select count(*) from public.pos_shift_count_checks c where c.pos_shift_id = s.id) as attempts,
      (select c.cash_difference from public.pos_shift_count_checks c where c.pos_shift_id = s.id order by c.attempt limit 1) as first_cash_difference,
      (select c.result -> 'accounts' from public.pos_shift_count_checks c where c.pos_shift_id = s.id order by c.attempt desc limit 1) as last_accounts,
      (select coalesce(sum(d.amount), 0) from public.pos_safe_deposits d where d.pos_shift_id = s.id and d.voided_at is null) as safe_total,
      (select count(*) from public.pos_safe_deposits d where d.pos_shift_id = s.id and d.voided_at is null) as safe_count,
      (select count(*) from public.audit_log al
         where al.company_id = v_company_id and al.action = 'pos_sale.change_payment_account'
           and al.entity_id in (select ps.id::text from public.pos_sales ps where ps.pos_shift_id = s.id)) as payment_changes
    from public.pos_shifts s
    left join public.employees e on e.id = s.cashier_employee_id
    left join public.profiles po on po.id = s.opened_by
    left join lateral (
      select al.new_data from public.audit_log al
      where al.company_id = v_company_id and al.action = 'pos_shift.close' and al.entity_id = s.id::text
      order by al.created_at desc limit 1
    ) a on true
    where s.company_id = v_company_id
      and s.branch_id = p_branch_id
      and s.opened_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 120)))
  ) x;

  return v_result;
end;
$$;
revoke all on function public.list_pos_shift_closes(uuid, integer) from public, anon;
grant execute on function public.list_pos_shift_closes(uuid, integer) to authenticated;

-- Reportes → por cajero: el nombre escrito al abrir va antes que el usuario de la PC.
do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_a1 constant text := $a$coalesce(e.full_name, pc.full_name, 'Sin nombre') as cashier_name$a$;
  v_b1 constant text := $b$coalesce(e.full_name, nullif(sh.cashier_name, ''), pc.full_name, 'Sin nombre') as cashier_name$b$;
  v_a2 constant text := $a$coalesce(e.full_name, po.full_name, 'Sin nombre') as cashier_name$a$;
  v_b2 constant text := $b$coalesce(e.full_name, nullif(sh.cashier_name, ''), po.full_name, 'Sin nombre') as cashier_name$b$;
begin
  select p.oid::regprocedure into v_proc from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'sales_activity_report'
  limit 1;
  if v_proc is null then
    raise notice '172: no está sales_activity_report: Reportes sigue como antes';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position('sh.cashier_name' in v_def) > 0 then
    raise notice '172: sales_activity_report ya usa el nombre de la caja';
    return;
  end if;
  if position(v_a1 in v_def) = 0 or position(v_a2 in v_def) = 0 then
    raise notice '172: sales_activity_report no tiene los puntos esperados: Reportes sigue como antes';
    return;
  end if;
  execute replace(replace(v_def, v_a1, v_b1), v_a2, v_b2);
end
$mig$;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('172_pos_shift_cashier_name') on conflict do nothing;
