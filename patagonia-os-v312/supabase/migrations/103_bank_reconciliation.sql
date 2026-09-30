-- 103 - Conciliación bancaria (Finanzas → Conciliación). Plan Full (decisión del
-- dueño 2026-09-29: las pantallas nuevas arrancan en Full; después se pueden bajar
-- de plan, nunca subir).
--
-- Rehecha el 2026-09-30 después de probar con un resumen REAL (Banco Provincia,
-- septiembre, 1.227 movimientos). Lo que mostraron los datos reales:
--   - Una cuenta del banco recibe plata de VARIAS cuentas de Tesorería (en
--     Carnes Patagonia: "Transferencia" y "Banco Provincia 2" = posnet caen en la
--     misma cuenta del Provincia). Por eso se concilia una "cuenta del banco"
--     (bank_reconciliation_accounts) que agrupa cuentas de Tesorería.
--   - En Tesorería, Mostrador carga UN total por cuenta al cerrar el turno
--     (movement_type 'venta', reference_type 'pos_shift'); el banco trae cada
--     transferencia suelta. Por eso el lado "sistema" usa los cobros
--     individuales de Mostrador (pos_sale_payments) en vez de esos totales.
--     Con eso, 258 de 321 transferencias cruzaron solas (mismo importe, 0 a 3 días).
--   - Las tarjetas se acreditan por lote, días hábiles después, por marca y con
--     la comisión descontada: no se cruzan venta por venta sino por período
--     (se marcan las acreditaciones como "acreditación de tarjetas").
--
-- El lector del resumen (cualquier banco) está en
-- apps/web/src/features/reconciliation/bank-statement.ts; las sugerencias de
-- cruce en reconcile-match.ts. Acá solo se guardan y se confirman.
-- Seguridad: RLS, lectura solo dueño/administrador de la empresa, sin escritura
-- directa (todo por RPC); plan Full en cada función y tabla.

create table if not exists public.bank_reconciliation_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  -- Cuentas de Tesorería cuya plata cae en esta cuenta del banco.
  treasury_account_ids uuid[] not null,
  -- Cuáles de esas son posnet/tarjetas (se concilian por período, no una a una).
  card_account_ids uuid[] not null default '{}',
  -- Donde se cargan las comisiones, impuestos y gastos que aparecen en el banco.
  main_treasury_account_id uuid not null references public.treasury_accounts(id),
  -- Formato del resumen confirmado por la persona (columnas), para la próxima vez.
  mapping jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recon_account_id uuid not null references public.bank_reconciliation_accounts(id) on delete cascade,
  file_name text,
  lines_new integer not null default 0,
  lines_repeated integer not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recon_account_id uuid not null references public.bank_reconciliation_accounts(id) on delete cascade,
  import_id uuid references public.bank_statement_imports(id) on delete set null,
  line_date date not null,
  description text not null default '',
  amount numeric(14,2) not null check (amount <> 0),
  reference text,
  balance numeric(14,2),
  line_key text not null,
  status text not null default 'pending' check (status in ('pending', 'matched', 'ignored')),
  -- 'card_deposit': acreditación de tarjetas conciliada por período (sin movimiento puntual).
  match_kind text check (match_kind is null or match_kind in ('card_deposit')),
  -- Movimiento que creó la conciliación (comisión o línea cargada desde el banco).
  created_movement_id uuid references public.treasury_movements(id) on delete set null,
  matched_by uuid references auth.users(id),
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recon_account_id, line_key)
);

create index if not exists bank_statement_lines_recon_idx on public.bank_statement_lines (recon_account_id, status, line_date);

create table if not exists public.bank_line_matches (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.bank_statement_lines(id) on delete cascade,
  -- Uno de los dos: un movimiento de Tesorería o un cobro de Mostrador. Cada uno
  -- se concilia una sola vez.
  movement_id uuid unique references public.treasury_movements(id) on delete cascade,
  payment_id uuid unique references public.pos_sale_payments(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  check (num_nonnulls(movement_id, payment_id) = 1)
);

create index if not exists bank_line_matches_line_idx on public.bank_line_matches (line_id);

alter table public.bank_reconciliation_accounts enable row level security;
alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.bank_line_matches enable row level security;

revoke all on public.bank_reconciliation_accounts, public.bank_statement_imports, public.bank_statement_lines, public.bank_line_matches from anon, authenticated;
grant select on public.bank_reconciliation_accounts, public.bank_statement_imports, public.bank_statement_lines, public.bank_line_matches to authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['bank_reconciliation_accounts', 'bank_statement_imports', 'bank_statement_lines', 'bank_line_matches']
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

-- Quién llama: dueño o administrador activo. Devuelve su empresa.
create or replace function public.reconciliation_caller_company()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;
  select company_id into v_company_id
  from public.profiles
  where id = auth.uid() and active and role in ('owner', 'admin');
  if v_company_id is null then
    raise exception 'No autorizado';
  end if;
  return v_company_id;
end;
$$;

revoke all on function public.reconciliation_caller_company() from public, anon;
grant execute on function public.reconciliation_caller_company() to authenticated;

create or replace function public.save_reconciliation_account(
  p_id uuid,
  p_name text,
  p_treasury_account_ids uuid[],
  p_card_account_ids uuid[],
  p_main_treasury_account_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_count integer;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Poné un nombre para la cuenta del banco';
  end if;
  if p_treasury_account_ids is null or array_length(p_treasury_account_ids, 1) is null then
    raise exception 'Elegí al menos una cuenta de Tesorería';
  end if;
  select count(*) into v_count from public.treasury_accounts
  where id = any(p_treasury_account_ids) and company_id = v_company_id;
  if v_count <> array_length(p_treasury_account_ids, 1) then
    raise exception 'Alguna cuenta de Tesorería no es válida';
  end if;
  if not (coalesce(p_card_account_ids, '{}') <@ p_treasury_account_ids) then
    raise exception 'Las cuentas de tarjeta tienen que estar entre las elegidas';
  end if;
  if not (p_main_treasury_account_id = any(p_treasury_account_ids)) then
    raise exception 'La cuenta para comisiones y gastos tiene que estar entre las elegidas';
  end if;

  if p_id is null then
    insert into public.bank_reconciliation_accounts (company_id, name, treasury_account_ids, card_account_ids, main_treasury_account_id)
    values (v_company_id, left(trim(p_name), 100), p_treasury_account_ids, coalesce(p_card_account_ids, '{}'), p_main_treasury_account_id)
    returning id into v_id;
  else
    update public.bank_reconciliation_accounts
    set name = left(trim(p_name), 100), treasury_account_ids = p_treasury_account_ids,
        card_account_ids = coalesce(p_card_account_ids, '{}'), main_treasury_account_id = p_main_treasury_account_id, updated_at = now()
    where id = p_id and company_id = v_company_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Cuenta del banco inválida';
    end if;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_reconciliation_account.save', 'bank_reconciliation_account', v_id::text,
          jsonb_build_object('name', p_name, 'accounts', to_jsonb(p_treasury_account_ids), 'cards', to_jsonb(p_card_account_ids)));
  return v_id;
end;
$$;

revoke all on function public.save_reconciliation_account(uuid, text, uuid[], uuid[], uuid) from public, anon;
grant execute on function public.save_reconciliation_account(uuid, text, uuid[], uuid[], uuid) to authenticated;

create or replace function public.import_bank_statement(
  p_recon_account_id uuid,
  p_file_name text,
  p_mapping jsonb,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_import_id uuid;
  v_line jsonb;
  v_new integer := 0;
  v_repeated integer := 0;
  v_amount numeric(14,2);
  v_date date;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  if not exists (select 1 from public.bank_reconciliation_accounts where id = p_recon_account_id and company_id = v_company_id) then
    raise exception 'Cuenta del banco inválida';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'El resumen no tiene movimientos';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'El resumen tiene demasiados movimientos (más de 5000). Subilo por mes.';
  end if;

  insert into public.bank_statement_imports (company_id, recon_account_id, file_name, created_by)
  values (v_company_id, p_recon_account_id, left(p_file_name, 200), v_user_id)
  returning id into v_import_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_amount := (v_line->>'amount')::numeric;
    v_date := (v_line->>'date')::date;
    if v_amount is null or v_amount = 0 or v_date is null or coalesce(v_line->>'key', '') = '' then
      raise exception 'Línea del resumen inválida';
    end if;

    insert into public.bank_statement_lines (company_id, recon_account_id, import_id, line_date, description, amount, reference, balance, line_key)
    values (
      v_company_id, p_recon_account_id, v_import_id, v_date,
      left(coalesce(v_line->>'description', ''), 300), v_amount,
      nullif(left(coalesce(v_line->>'reference', ''), 100), ''),
      nullif(v_line->>'balance', '')::numeric,
      left(v_line->>'key', 400)
    )
    on conflict (recon_account_id, line_key) do nothing;

    if found then
      v_new := v_new + 1;
    else
      v_repeated := v_repeated + 1;
    end if;
  end loop;

  update public.bank_statement_imports set lines_new = v_new, lines_repeated = v_repeated where id = v_import_id;

  if p_mapping is not null and jsonb_typeof(p_mapping) = 'object' then
    update public.bank_reconciliation_accounts set mapping = p_mapping, updated_at = now() where id = p_recon_account_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.import', 'bank_reconciliation_account', p_recon_account_id::text,
          jsonb_build_object('import_id', v_import_id, 'new', v_new, 'repeated', v_repeated, 'file', p_file_name));

  return jsonb_build_object('import_id', v_import_id, 'new', v_new, 'repeated', v_repeated);
end;
$$;

revoke all on function public.import_bank_statement(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.import_bank_statement(uuid, text, jsonb, jsonb) to authenticated;

-- Lado "sistema" para un período: cobros individuales de Mostrador de las
-- cuentas del grupo (en vez de los totales por turno que Mostrador carga en
-- Tesorería) + el resto de los movimientos de Tesorería de esas cuentas.
create or replace function public.get_reconciliation_items(p_recon_account_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_acc public.bank_reconciliation_accounts%rowtype;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  select * into v_acc from public.bank_reconciliation_accounts where id = p_recon_account_id and company_id = v_company_id;
  if not found then
    raise exception 'Cuenta del banco inválida';
  end if;

  return jsonb_build_object(
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'date', (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
        'account_id', p.account_id, 'amount', p.amount, 'reference', p.reference,
        'reconciled', exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id)
      ) order by s.created_at)
      from public.pos_sale_payments p
      join public.pos_sales s on s.id = p.sale_id
      where s.company_id = v_company_id and s.voided_at is null
        and p.account_id = any(v_acc.treasury_account_ids)
        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'date', m.occurred_on, 'account_id', m.account_id, 'direction', m.direction,
        'amount', m.amount, 'type', m.movement_type, 'notes', m.notes,
        'reconciled', exists (select 1 from public.bank_line_matches bm where bm.movement_id = m.id)
      ) order by m.occurred_on, m.created_at)
      from public.treasury_movements m
      where m.company_id = v_company_id
        and m.account_id = any(v_acc.treasury_account_ids)
        and m.occurred_on between p_from and p_to
        and not (m.movement_type = 'venta' and m.reference_type = 'pos_shift')
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_reconciliation_items(uuid, date, date) from public, anon;
grant execute on function public.get_reconciliation_items(uuid, date, date) to authenticated;

-- Confirmar el cruce de una línea con cobros y/o movimientos. p_fee: la
-- diferencia que se carga como gasto (comisión), solo para entradas. Tiene que
-- cerrar exacto: línea = (cobros + entradas − salidas) − comisión.
create or replace function public.confirm_bank_match(p_line_id uuid, p_movement_ids uuid[], p_payment_ids uuid[], p_fee numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_line public.bank_statement_lines%rowtype;
  v_acc public.bank_reconciliation_accounts%rowtype;
  v_movement_ids uuid[] := coalesce(p_movement_ids, '{}');
  v_payment_ids uuid[] := coalesce(p_payment_ids, '{}');
  v_count integer;
  v_total numeric(14,2) := 0;
  v_part numeric(14,2);
  v_branch_id uuid;
  v_fee numeric(14,2) := round(coalesce(p_fee, 0), 2);
  v_fee_movement_id uuid;
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
  select * into v_acc from public.bank_reconciliation_accounts where id = v_line.recon_account_id;
  if coalesce(array_length(v_movement_ids, 1), 0) + coalesce(array_length(v_payment_ids, 1), 0) = 0 then
    raise exception 'Elegí al menos un movimiento';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_line.amount < 0) then
    raise exception 'Comisión inválida';
  end if;

  if array_length(v_movement_ids, 1) is not null then
    select count(*), coalesce(sum(case when m.direction = 'in' then m.amount else -m.amount end), 0), min(m.branch_id::text)::uuid
    into v_count, v_part, v_branch_id
    from public.treasury_movements m
    where m.id = any(v_movement_ids) and m.company_id = v_company_id
      and m.account_id = any(v_acc.treasury_account_ids)
      and not exists (select 1 from public.bank_line_matches bm where bm.movement_id = m.id);
    if v_count <> array_length(v_movement_ids, 1) then
      raise exception 'Algún movimiento no es de estas cuentas o ya está conciliado';
    end if;
    v_total := v_total + v_part;
  end if;

  if array_length(v_payment_ids, 1) is not null then
    select count(*), coalesce(sum(p.amount), 0), coalesce(v_branch_id, min(s.branch_id::text)::uuid)
    into v_count, v_part, v_branch_id
    from public.pos_sale_payments p
    join public.pos_sales s on s.id = p.sale_id
    where p.id = any(v_payment_ids) and s.company_id = v_company_id and s.voided_at is null
      and p.account_id = any(v_acc.treasury_account_ids)
      and not exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id);
    if v_count <> array_length(v_payment_ids, 1) then
      raise exception 'Algún cobro no es de estas cuentas o ya está conciliado';
    end if;
    v_total := v_total + v_part;
  end if;

  if v_total - v_fee <> v_line.amount then
    raise exception 'No cierra: el banco dice % y lo elegido suma % (comisión %)', v_line.amount, v_total, v_fee;
  end if;

  if v_fee > 0 then
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
    values (v_company_id, v_branch_id, v_acc.main_treasury_account_id, 'out', v_fee, 'gasto', 'otro', v_line.line_date,
            left('Comisión y retenciones del banco (conciliación): ' || v_line.description, 300), v_user_id)
    returning id into v_fee_movement_id;
  end if;

  insert into public.bank_line_matches (line_id, movement_id, company_id)
  select p_line_id, unnest(v_movement_ids), v_company_id;
  insert into public.bank_line_matches (line_id, payment_id, company_id)
  select p_line_id, unnest(v_payment_ids), v_company_id;

  update public.bank_statement_lines
  set status = 'matched', created_movement_id = v_fee_movement_id, matched_by = v_user_id, matched_at = now()
  where id = p_line_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('movements', to_jsonb(v_movement_ids), 'payments', to_jsonb(v_payment_ids), 'fee', v_fee));
end;
$$;

revoke all on function public.confirm_bank_match(uuid, uuid[], uuid[], numeric) from public, anon;
grant execute on function public.confirm_bank_match(uuid, uuid[], uuid[], numeric) to authenticated;

-- Confirmar muchas coincidencias de una vez (ej. las 258 transferencias del
-- mes): p_matches = [{line_id, movement_ids, payment_ids}], sin comisión.
-- Todo o nada: si una no cierra, no se confirma ninguna.
create or replace function public.confirm_bank_matches(p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $
declare
  v_match jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 5000 then
    raise exception 'Lista de coincidencias inválida';
  end if;
  for v_match in select * from jsonb_array_elements(p_matches)
  loop
    perform public.confirm_bank_match(
      (v_match->>'line_id')::uuid,
      array(select jsonb_array_elements_text(coalesce(v_match->'movement_ids', '[]'::jsonb))::uuid),
      array(select jsonb_array_elements_text(coalesce(v_match->'payment_ids', '[]'::jsonb))::uuid),
      0
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$;

revoke all on function public.confirm_bank_matches(jsonb) from public, anon;
grant execute on function public.confirm_bank_matches(jsonb) to authenticated;

-- Acreditaciones de tarjetas: se concilian por período (el banco deposita por
-- lote, por marca, días después y con la comisión descontada).
create or replace function public.mark_bank_lines_card_deposit(p_line_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_count integer;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  update public.bank_statement_lines
  set status = 'matched', match_kind = 'card_deposit', matched_by = auth.uid(), matched_at = now()
  where id = any(coalesce(p_line_ids, '{}')) and company_id = v_company_id and status = 'pending' and amount > 0;
  get diagnostics v_count = row_count;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_statement.card_deposit', 'bank_statement_line', null,
          jsonb_build_object('lines', to_jsonb(p_line_ids), 'count', v_count));
  return v_count;
end;
$$;

revoke all on function public.mark_bank_lines_card_deposit(uuid[]) from public, anon;
grant execute on function public.mark_bank_lines_card_deposit(uuid[]) to authenticated;

-- Línea que está en el banco y no en el sistema: cargarla como movimiento de
-- Tesorería en la cuenta principal (gasto si salió plata, ajuste si entró).
create or replace function public.create_movement_from_bank_line(p_line_id uuid, p_branch_id uuid, p_category text, p_notes text)
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
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if v_line.amount < 0 and coalesce(p_category, '') not in ('mantenimiento', 'servicios', 'impuestos', 'insumos', 'otro') then
    raise exception 'Categoría inválida';
  end if;
  select main_treasury_account_id into v_main from public.bank_reconciliation_accounts where id = v_line.recon_account_id;

  insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
  values (
    v_company_id, p_branch_id, v_main,
    case when v_line.amount > 0 then 'in' else 'out' end,
    abs(v_line.amount),
    case when v_line.amount > 0 then 'ajuste' else 'gasto' end,
    case when v_line.amount > 0 then null else p_category end,
    v_line.line_date,
    left(coalesce(nullif(trim(p_notes), ''), v_line.description) || ' (desde el resumen del banco)', 300),
    v_user_id
  )
  returning id into v_movement_id;

  insert into public.bank_line_matches (line_id, movement_id, company_id) values (p_line_id, v_movement_id, v_company_id);

  update public.bank_statement_lines
  set status = 'matched', created_movement_id = v_movement_id, matched_by = v_user_id, matched_at = now()
  where id = p_line_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'bank_statement.create_movement', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('movement_id', v_movement_id, 'amount', v_line.amount, 'category', p_category));

  return v_movement_id;
end;
$$;

revoke all on function public.create_movement_from_bank_line(uuid, uuid, text, text) from public, anon;
grant execute on function public.create_movement_from_bank_line(uuid, uuid, text, text) to authenticated;

-- Varias líneas iguales de golpe (ej. todos los "IMPUESTO CREDITO -LEY 25413"
-- del mes): cada una se carga como su propio gasto.
create or replace function public.create_movements_from_bank_lines(p_line_ids uuid[], p_branch_id uuid, p_category text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  foreach v_id in array coalesce(p_line_ids, '{}')
  loop
    perform public.create_movement_from_bank_line(v_id, p_branch_id, p_category, null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.create_movements_from_bank_lines(uuid[], uuid, text) from public, anon;
grant execute on function public.create_movements_from_bank_lines(uuid[], uuid, text) to authenticated;

create or replace function public.set_bank_line_ignored(p_line_id uuid, p_ignored boolean)
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

  update public.bank_statement_lines
  set status = case when p_ignored then 'ignored' else 'pending' end,
      matched_by = case when p_ignored then auth.uid() else null end,
      matched_at = case when p_ignored then now() else null end
  where id = p_line_id and company_id = v_company_id and status in ('pending', 'ignored');
  if not found then
    raise exception 'Línea inválida o ya conciliada';
  end if;
end;
$$;

revoke all on function public.set_bank_line_ignored(uuid, boolean) from public, anon;
grant execute on function public.set_bank_line_ignored(uuid, boolean) to authenticated;

-- Deshacer: la línea vuelve a pendiente, lo cruzado queda libre y se borra el
-- movimiento que había creado la conciliación (comisión o gasto del banco).
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
    delete from public.treasury_movements where id = v_line.created_movement_id and company_id = v_company_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.undo_match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('deleted_movement_id', v_line.created_movement_id, 'kind', v_line.match_kind));
end;
$$;

revoke all on function public.undo_bank_match(uuid) from public, anon;
grant execute on function public.undo_bank_match(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('103_bank_reconciliation') on conflict do nothing;
