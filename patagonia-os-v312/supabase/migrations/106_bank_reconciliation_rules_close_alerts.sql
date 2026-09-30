-- 106 - Conciliación, tercera vuelta (2026-09-30, "hacé todo"):
--
-- 1. Alerta de transferencias que no llegaron: cobros de Mostrador (no tarjeta)
--    en una cuenta que se concilia, con 3+ días de antigüedad dentro del
--    período que ya cubre el resumen importado, sin conciliar y sin ninguna
--    línea del banco parecida (mismo importe ±$500/2%, de 3 días antes a 7
--    después). Es la estafa del comprobante de transferencia falso. Se muestra
--    en el Inicio (dueño/admin) y en Conciliación, con quién cobró.
-- 2. Reglas: "el texto X del banco es siempre esto" (gasto con categoría,
--    ingreso, cobro de un cliente o ignorar). Se aplican a las líneas que
--    quedan "en el banco y no en el sistema"; la pantalla propone y la base
--    valida que el texto coincida de verdad.
-- 3. Cobro de cliente desde una línea del banco (ej. los DEBIN de clientes
--    que pagan desde una billetera): usa register_customer_payment, así baja
--    la deuda del cliente, y al deshacer se borra ese cobro.
-- 4. Cierre del mes: planilla guardada + lo conciliado hasta esa fecha queda
--    trabado (no se puede deshacer ni des-ignorar). Lo pendiente se puede
--    seguir conciliando después (partidas que pasan al mes siguiente).
--
-- Todo plan Full, dueño/administrador, como 103/105.

-- ------------------------------------------------------------------ reglas

create table if not exists public.bank_reconciliation_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recon_account_id uuid not null references public.bank_reconciliation_accounts(id) on delete cascade,
  -- Texto a buscar en la descripción del banco, en mayúsculas (ej. "IMPUESTO CREDITO" o un CUIT).
  match_text text not null check (length(match_text) between 3 and 80),
  direction text not null check (direction in ('in', 'out')),
  action text not null check (action in ('expense', 'income', 'customer', 'ignore')),
  category text check (category is null or category in ('mantenimiento', 'servicios', 'impuestos', 'insumos', 'otro')),
  customer_id uuid references public.customers(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (recon_account_id, direction, match_text),
  check ((action = 'expense') = (category is not null)),
  check ((action = 'customer') = (customer_id is not null)),
  check (action <> 'expense' or direction = 'out'),
  check (action not in ('income', 'customer') or direction = 'in')
);

-- ------------------------------------------------------------------ cierres

create table if not exists public.bank_reconciliation_closes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recon_account_id uuid not null references public.bank_reconciliation_accounts(id) on delete cascade,
  period_from date not null,
  period_end date not null,
  bank_balance numeric(14,2) not null,
  -- Saldo de las cuentas de Tesorería del grupo a esa fecha (lo calcula la base).
  system_balance numeric(14,2) not null,
  -- Planilla tal como se vio al cerrar (partidas pendientes, tarjetas, diferencia).
  detail jsonb not null default '{}'::jsonb,
  closed_by uuid references auth.users(id),
  closed_at timestamptz not null default now(),
  unique (recon_account_id, period_end),
  check (period_from <= period_end)
);

alter table public.bank_reconciliation_rules enable row level security;
alter table public.bank_reconciliation_closes enable row level security;
revoke all on public.bank_reconciliation_rules, public.bank_reconciliation_closes from anon, authenticated;
grant select on public.bank_reconciliation_rules, public.bank_reconciliation_closes to authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['bank_reconciliation_rules', 'bank_reconciliation_closes']
  loop
    execute format('drop policy if exists reconciliation_read on public.%I', v_table);
    execute format(
      'create policy reconciliation_read on public.%I for select to authenticated
         using (company_id = public.current_company_id()
                and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in (''owner'', ''admin'')))',
      v_table
    );
    execute format('drop policy if exists plan_full on public.%I', v_table);
    execute format(
      'create policy plan_full on public.%I as restrictive for all to authenticated
         using ((select public.company_plan_allows(''full'')))
         with check ((select public.company_plan_allows(''full'')))',
      v_table
    );
  end loop;
end $$;

-- Mes cerrado: lo conciliado/ignorado no se toca, y no entran líneas nuevas
-- con fecha dentro del mes cerrado (al reimportar se cuentan como repetidas).
create or replace function public.bank_lines_closed_period_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_line public.bank_statement_lines%rowtype;
begin
  v_line := new;
  if not exists (
    select 1 from public.bank_reconciliation_closes c
    where c.recon_account_id = v_line.recon_account_id and c.period_end >= v_line.line_date
  ) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    return null;
  end if;
  -- Lo pendiente de un mes cerrado se puede seguir conciliando.
  if old.status = 'pending' then
    return new;
  end if;
  raise exception 'Ese mes ya está cerrado en la conciliación. Para cambiarlo, reabrí el cierre.';
end;
$$;

revoke all on function public.bank_lines_closed_period_guard() from public, anon, authenticated;

drop trigger if exists bank_lines_closed_period_guard on public.bank_statement_lines;
create trigger bank_lines_closed_period_guard
before insert or update on public.bank_statement_lines
for each row execute function public.bank_lines_closed_period_guard();

-- ------------------------------------------------------------------ reglas: RPC

create or replace function public.save_reconciliation_rule(
  p_recon_account_id uuid,
  p_match_text text,
  p_direction text,
  p_action text,
  p_category text,
  p_customer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_text text := upper(regexp_replace(trim(coalesce(p_match_text, '')), '\s+', ' ', 'g'));
  v_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  if not exists (select 1 from public.bank_reconciliation_accounts where id = p_recon_account_id and company_id = v_company_id) then
    raise exception 'Cuenta del banco inválida';
  end if;
  if length(v_text) < 3 then
    raise exception 'El texto de la regla es muy corto';
  end if;
  if p_customer_id is not null and not exists (select 1 from public.customers where id = p_customer_id and company_id = v_company_id) then
    raise exception 'Cliente inválido';
  end if;

  insert into public.bank_reconciliation_rules (company_id, recon_account_id, match_text, direction, action, category, customer_id, created_by)
  values (
    v_company_id, p_recon_account_id, left(v_text, 80), p_direction, p_action,
    case when p_action = 'expense' then p_category end,
    case when p_action = 'customer' then p_customer_id end,
    auth.uid()
  )
  on conflict (recon_account_id, direction, match_text) do update
    set action = excluded.action, category = excluded.category, customer_id = excluded.customer_id
  returning id into v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_rule.save', 'bank_reconciliation_rule', v_id::text,
          jsonb_build_object('text', v_text, 'direction', p_direction, 'action', p_action, 'category', p_category, 'customer_id', p_customer_id));
  return v_id;
end;
$$;

revoke all on function public.save_reconciliation_rule(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.save_reconciliation_rule(uuid, text, text, text, text, uuid) to authenticated;

create or replace function public.delete_reconciliation_rule(p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  delete from public.bank_reconciliation_rules where id = p_rule_id and company_id = v_company_id;
  if not found then
    raise exception 'Regla inválida';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_rule.delete', 'bank_reconciliation_rule', p_rule_id::text, '{}'::jsonb);
end;
$$;

revoke all on function public.delete_reconciliation_rule(uuid) from public, anon;
grant execute on function public.delete_reconciliation_rule(uuid) to authenticated;

-- ------------------------------------------------------------------ cobro de cliente desde el banco

create or replace function public.create_customer_payment_from_bank_line(p_line_id uuid, p_customer_id uuid, p_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_line public.bank_statement_lines%rowtype;
  v_main uuid;
  v_result jsonb;
  v_movement_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select * into v_line from public.bank_statement_lines where id = p_line_id and company_id = v_company_id for update;
  if not found then
    raise exception 'Línea inválida';
  end if;
  if v_line.status <> 'pending' then
    raise exception 'Esa línea ya está conciliada o ignorada';
  end if;
  if v_line.amount <= 0 then
    raise exception 'Solo lo que entró puede ser un cobro de cliente';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;
  select main_treasury_account_id into v_main from public.bank_reconciliation_accounts where id = v_line.recon_account_id;

  -- Mismo camino que Clientes → Registrar pago (baja la deuda del cliente).
  v_result := public.register_customer_payment(
    p_customer_id, p_branch_id, v_line.line_date, v_line.amount, v_main,
    left('Cobro desde el banco: ' || v_line.description, 300)
  );
  select treasury_movement_id into v_movement_id from public.customer_payments where id = (v_result->>'id')::uuid;

  insert into public.bank_line_matches (line_id, movement_id, company_id) values (p_line_id, v_movement_id, v_company_id);
  update public.bank_statement_lines
  set status = 'matched', created_movement_id = v_movement_id, matched_by = v_user_id, matched_at = now()
  where id = p_line_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'bank_statement.customer_payment', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('customer_id', p_customer_id, 'customer_payment_id', v_result->>'id', 'amount', v_line.amount));
  return v_movement_id;
end;
$$;

revoke all on function public.create_customer_payment_from_bank_line(uuid, uuid, uuid) from public, anon;
grant execute on function public.create_customer_payment_from_bank_line(uuid, uuid, uuid) to authenticated;

-- Aplicar reglas: p_items = [{line_id, rule_id}]. Todo o nada. La base
-- verifica que el texto y el sentido de la regla coincidan con la línea.
create or replace function public.apply_reconciliation_rules(p_items jsonb, p_branch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_item jsonb;
  v_line public.bank_statement_lines%rowtype;
  v_rule public.bank_reconciliation_rules%rowtype;
  v_count integer := 0;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000 then
    raise exception 'Lista inválida';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_line from public.bank_statement_lines where id = (v_item->>'line_id')::uuid and company_id = v_company_id;
    select * into v_rule from public.bank_reconciliation_rules where id = (v_item->>'rule_id')::uuid and company_id = v_company_id;
    if v_line.id is null or v_rule.id is null or v_rule.recon_account_id <> v_line.recon_account_id
       or (v_rule.direction = 'in') <> (v_line.amount > 0)
       or position(v_rule.match_text in upper(regexp_replace(v_line.description, '\s+', ' ', 'g'))) = 0 then
      raise exception 'La regla no corresponde a esa línea';
    end if;

    if v_rule.action = 'expense' then
      perform public.create_movement_from_bank_line(v_line.id, p_branch_id, v_rule.category, null);
    elsif v_rule.action = 'income' then
      perform public.create_movement_from_bank_line(v_line.id, p_branch_id, null, null);
    elsif v_rule.action = 'customer' then
      perform public.create_customer_payment_from_bank_line(v_line.id, v_rule.customer_id, p_branch_id);
    else
      perform public.set_bank_line_ignored(v_line.id, true);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.apply_reconciliation_rules(jsonb, uuid) from public, anon;
grant execute on function public.apply_reconciliation_rules(jsonb, uuid) to authenticated;

-- Deshacer (reemplaza la de 103): si la línea se había cargado como cobro de
-- cliente, se borra ese cobro (vuelve la deuda) antes que el movimiento.
create or replace function public.undo_bank_match(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_line public.bank_statement_lines%rowtype;
  v_customer_payment_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select * into v_line from public.bank_statement_lines where id = p_line_id and company_id = v_company_id for update;
  if not found or v_line.status <> 'matched' then
    raise exception 'Línea inválida o no conciliada';
  end if;

  delete from public.bank_line_matches where line_id = p_line_id;
  update public.bank_statement_lines
  set status = 'pending', match_kind = null, created_movement_id = null, matched_by = null, matched_at = null
  where id = p_line_id;
  if v_line.created_movement_id is not null then
    delete from public.customer_payments
    where treasury_movement_id = v_line.created_movement_id and company_id = v_company_id
    returning id into v_customer_payment_id;
    delete from public.treasury_movements where id = v_line.created_movement_id and company_id = v_company_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.undo_match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('deleted_movement_id', v_line.created_movement_id, 'deleted_customer_payment_id', v_customer_payment_id, 'kind', v_line.match_kind));
end;
$$;

revoke all on function public.undo_bank_match(uuid) from public, anon;
grant execute on function public.undo_bank_match(uuid) to authenticated;

-- ------------------------------------------------------------------ alerta

-- p_recon_account_id null = todas las cuentas del banco de la empresa (Inicio).
create or replace function public.get_reconciliation_alerts(p_recon_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  return coalesce((
    select jsonb_agg(x order by x->>'date', x->>'id')
    from (
      select jsonb_build_object(
        'id', p.id,
        'recon_account_id', ra.id,
        'recon_account_name', ra.name,
        'date', (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
        'time', to_char(s.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI'),
        'amount', p.amount,
        'account_name', ta.name,
        'reference', p.reference,
        'cashier', coalesce(pr.full_name, 'Sin nombre'),
        'branch_name', b.name
      ) as x
      from public.bank_reconciliation_accounts ra
      join lateral (
        select min(l.line_date) as first_day, max(l.line_date) as last_day
        from public.bank_statement_lines l where l.recon_account_id = ra.id
      ) cover on cover.last_day is not null
      join public.pos_sale_payments p on p.account_id = any(ra.treasury_account_ids) and not (p.account_id = any(ra.card_account_ids))
      join public.pos_sales s on s.id = p.sale_id
      left join public.treasury_accounts ta on ta.id = p.account_id
      left join public.profiles pr on pr.id = s.created_by
      left join public.branches b on b.id = s.branch_id
      where ra.company_id = v_company_id
        and (p_recon_account_id is null or ra.id = p_recon_account_id)
        and s.company_id = v_company_id and s.voided_at is null
        and p.amount > 0
        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between cover.first_day and cover.last_day - 3
        and not exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id)
        and not exists (
          select 1 from public.bank_statement_lines l
          where l.recon_account_id = ra.id and l.amount > 0 and l.status <> 'ignored'
            and abs(l.amount - p.amount) <= greatest(500, p.amount * 0.02)
            and l.line_date between (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date - 3
                                and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date + 7
        )
      limit 500
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_reconciliation_alerts(uuid) from public, anon;
grant execute on function public.get_reconciliation_alerts(uuid) to authenticated;

-- ------------------------------------------------------------------ cierre del mes

-- Saldo de las cuentas de Tesorería del grupo a una fecha (inicial + entradas − salidas).
create or replace function public.reconciliation_system_balance(p_recon_account_id uuid, p_date date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_acc public.bank_reconciliation_accounts%rowtype;
  v_initial numeric;
  v_moves numeric;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  select * into v_acc from public.bank_reconciliation_accounts where id = p_recon_account_id and company_id = v_company_id;
  if not found then
    raise exception 'Cuenta del banco inválida';
  end if;
  select coalesce(sum(initial_balance), 0) into v_initial
  from public.treasury_accounts where id = any(v_acc.treasury_account_ids) and company_id = v_company_id;
  select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) into v_moves
  from public.treasury_movements
  where account_id = any(v_acc.treasury_account_ids) and company_id = v_company_id and occurred_on <= p_date;
  return round(v_initial + v_moves, 2);
end;
$$;

revoke all on function public.reconciliation_system_balance(uuid, date) from public, anon;
grant execute on function public.reconciliation_system_balance(uuid, date) to authenticated;

create or replace function public.close_reconciliation_period(
  p_recon_account_id uuid,
  p_period_from date,
  p_period_end date,
  p_bank_balance numeric,
  p_detail jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_system numeric;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  if p_period_end is null or p_period_from is null or p_period_from > p_period_end then
    raise exception 'Período inválido';
  end if;
  if p_period_end > public.today_ar() then
    raise exception 'No se puede cerrar un período que todavía no terminó';
  end if;
  if p_bank_balance is null then
    raise exception 'Poné el saldo que dice el banco a esa fecha';
  end if;
  v_system := public.reconciliation_system_balance(p_recon_account_id, p_period_end);

  insert into public.bank_reconciliation_closes (company_id, recon_account_id, period_from, period_end, bank_balance, system_balance, detail, closed_by)
  values (v_company_id, p_recon_account_id, p_period_from, p_period_end, round(p_bank_balance, 2), v_system,
          case when jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end, auth.uid())
  returning id into v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_reconciliation.close', 'bank_reconciliation_close', v_id::text,
          jsonb_build_object('recon_account_id', p_recon_account_id, 'from', p_period_from, 'to', p_period_end,
                             'bank_balance', p_bank_balance, 'system_balance', v_system));
  return v_id;
end;
$$;

revoke all on function public.close_reconciliation_period(uuid, date, date, numeric, jsonb) from public, anon;
grant execute on function public.close_reconciliation_period(uuid, date, date, numeric, jsonb) to authenticated;

create or replace function public.reopen_reconciliation_period(p_close_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_close public.bank_reconciliation_closes%rowtype;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  delete from public.bank_reconciliation_closes where id = p_close_id and company_id = v_company_id returning * into v_close;
  if v_close.id is null then
    raise exception 'Cierre inválido';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, auth.uid(), 'bank_reconciliation.reopen', 'bank_reconciliation_close', p_close_id::text, to_jsonb(v_close));
end;
$$;

revoke all on function public.reopen_reconciliation_period(uuid) from public, anon;
grant execute on function public.reopen_reconciliation_period(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('106_bank_reconciliation_rules_close_alerts') on conflict do nothing;
