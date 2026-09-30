-- 103 - Conciliación bancaria (Tesorería → Conciliación). Plan Estándar.
--
-- El dueño sube el resumen de su banco o billetera (Excel/CSV de CUALQUIER
-- banco: el lector está en apps/web/src/features/reconciliation/bank-statement.ts
-- y se adapta a las columnas; el formato confirmado se guarda por cuenta).
-- Cada línea del resumen se cruza con los movimientos de Tesorería de esa
-- cuenta (sugerencias en reconcile-match.ts; acá solo se confirman):
--   - uno a uno (transferencia, pago, gasto con el mismo importe), o
--   - muchos a uno (el posnet deposita las ventas de un día juntas, días
--     después y con la comisión descontada: la diferencia se carga como
--     gasto "comisión y retenciones" en la misma cuenta).
-- Las líneas que están en el banco y no en el sistema (comisiones,
-- impuestos, débitos automáticos, transferencias no cargadas) se pueden
-- cargar como movimiento con un botón, o marcar "ignorar".
--
-- Seguridad: tablas con RLS, lectura solo dueño/administrador de la empresa
-- (mismo criterio que Tesorería), sin escritura directa: todo por RPC.

create table if not exists public.bank_statement_formats (
  account_id uuid primary key references public.treasury_accounts(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  mapping jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id) on delete cascade,
  file_name text,
  lines_new integer not null default 0,
  lines_repeated integer not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id) on delete cascade,
  import_id uuid references public.bank_statement_imports(id) on delete set null,
  line_date date not null,
  description text not null default '',
  amount numeric(14,2) not null check (amount <> 0),
  reference text,
  balance numeric(14,2),
  line_key text not null,
  status text not null default 'pending' check (status in ('pending', 'matched', 'ignored')),
  -- Movimiento que creó la conciliación (comisión o línea cargada desde el
  -- banco). Al deshacer la conciliación se borra.
  created_movement_id uuid references public.treasury_movements(id) on delete set null,
  matched_by uuid references auth.users(id),
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, line_key)
);

create index if not exists bank_statement_lines_account_idx on public.bank_statement_lines (account_id, status, line_date);

create table if not exists public.bank_line_matches (
  line_id uuid not null references public.bank_statement_lines(id) on delete cascade,
  -- Un movimiento de Tesorería se concilia una sola vez.
  movement_id uuid not null unique references public.treasury_movements(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  primary key (line_id, movement_id)
);

alter table public.bank_statement_formats enable row level security;
alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.bank_line_matches enable row level security;

revoke all on public.bank_statement_formats, public.bank_statement_imports, public.bank_statement_lines, public.bank_line_matches from anon, authenticated;
grant select on public.bank_statement_formats, public.bank_statement_imports, public.bank_statement_lines, public.bank_line_matches to authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['bank_statement_formats', 'bank_statement_imports', 'bank_statement_lines', 'bank_line_matches']
  loop
    execute format('drop policy if exists reconciliation_read on public.%I', v_table);
    execute format(
      'create policy reconciliation_read on public.%I for select to authenticated
         using (company_id = public.current_company_id()
                and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in (''owner'', ''admin'')))',
      v_table
    );
    execute format('drop policy if exists plan_estandar on public.%I', v_table);
    execute format(
      'create policy plan_estandar on public.%I as restrictive for all to authenticated
         using ((select public.company_plan_allows(''estandar'')))
         with check ((select public.company_plan_allows(''estandar'')))',
      v_table
    );
  end loop;
end $$;

-- Quién llama: empresa, con rol dueño/administrador activo. Devuelve company_id.
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

revoke all on function public.reconciliation_caller_company() from public;
grant execute on function public.reconciliation_caller_company() to authenticated;

create or replace function public.import_bank_statement(
  p_account_id uuid,
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
  perform public.require_plan('estandar');
  v_company_id := public.reconciliation_caller_company();

  if not exists (select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id) then
    raise exception 'Cuenta inválida';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'El resumen no tiene movimientos';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'El resumen tiene demasiados movimientos (más de 5000). Subilo por mes.';
  end if;

  insert into public.bank_statement_imports (company_id, account_id, file_name, created_by)
  values (v_company_id, p_account_id, left(p_file_name, 200), v_user_id)
  returning id into v_import_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_amount := (v_line->>'amount')::numeric;
    v_date := (v_line->>'date')::date;
    if v_amount is null or v_amount = 0 or v_date is null or coalesce(v_line->>'key', '') = '' then
      raise exception 'Línea del resumen inválida';
    end if;

    insert into public.bank_statement_lines (company_id, account_id, import_id, line_date, description, amount, reference, balance, line_key)
    values (
      v_company_id, p_account_id, v_import_id, v_date,
      left(coalesce(v_line->>'description', ''), 300), v_amount,
      nullif(left(coalesce(v_line->>'reference', ''), 100), ''),
      nullif(v_line->>'balance', '')::numeric,
      left(v_line->>'key', 400)
    )
    on conflict (account_id, line_key) do nothing;

    if found then
      v_new := v_new + 1;
    else
      v_repeated := v_repeated + 1;
    end if;
  end loop;

  update public.bank_statement_imports set lines_new = v_new, lines_repeated = v_repeated where id = v_import_id;

  if p_mapping is not null and jsonb_typeof(p_mapping) = 'object' then
    insert into public.bank_statement_formats (account_id, company_id, mapping, updated_at)
    values (p_account_id, v_company_id, p_mapping, now())
    on conflict (account_id) do update set mapping = excluded.mapping, updated_at = now();
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.import', 'treasury_account', p_account_id::text,
          jsonb_build_object('import_id', v_import_id, 'new', v_new, 'repeated', v_repeated, 'file', p_file_name));

  return jsonb_build_object('import_id', v_import_id, 'new', v_new, 'repeated', v_repeated);
end;
$$;

revoke all on function public.import_bank_statement(uuid, text, jsonb, jsonb) from public;
grant execute on function public.import_bank_statement(uuid, text, jsonb, jsonb) to authenticated;

-- Confirmar el cruce de una línea con uno o más movimientos. p_fee: la
-- diferencia que se carga como gasto (comisión y retenciones), solo para
-- depósitos. Tiene que cerrar exacto: línea = suma movimientos − comisión.
create or replace function public.confirm_bank_match(p_line_id uuid, p_movement_ids uuid[], p_fee numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_line public.bank_statement_lines%rowtype;
  v_count integer;
  v_total numeric(14,2);
  v_branch_id uuid;
  v_fee numeric(14,2) := round(coalesce(p_fee, 0), 2);
  v_fee_movement_id uuid;
begin
  perform public.require_plan('estandar');
  v_company_id := public.reconciliation_caller_company();

  select * into v_line from public.bank_statement_lines where id = p_line_id and company_id = v_company_id for update;
  if not found then
    raise exception 'Línea inválida';
  end if;
  if v_line.status <> 'pending' then
    raise exception 'Esa línea ya está conciliada o ignorada';
  end if;
  if p_movement_ids is null or array_length(p_movement_ids, 1) is null then
    raise exception 'Elegí al menos un movimiento';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_line.amount < 0) then
    raise exception 'Comisión inválida';
  end if;

  select count(*), coalesce(sum(case when m.direction = 'in' then m.amount else -m.amount end), 0), min(m.branch_id::text)::uuid
  into v_count, v_total, v_branch_id
  from public.treasury_movements m
  where m.id = any(p_movement_ids)
    and m.company_id = v_company_id
    and m.account_id = v_line.account_id
    and not exists (select 1 from public.bank_line_matches bm where bm.movement_id = m.id);

  if v_count <> array_length(p_movement_ids, 1) then
    raise exception 'Algún movimiento no es de esta cuenta o ya está conciliado';
  end if;
  if v_total - v_fee <> v_line.amount then
    raise exception 'No cierra: el banco dice % y los movimientos elegidos suman % (comisión %)', v_line.amount, v_total, v_fee;
  end if;

  if v_fee > 0 then
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
    values (v_company_id, v_branch_id, v_line.account_id, 'out', v_fee, 'gasto', 'otro', v_line.line_date,
            left('Comisión y retenciones del banco (conciliación): ' || v_line.description, 300), v_user_id)
    returning id into v_fee_movement_id;
  end if;

  insert into public.bank_line_matches (line_id, movement_id, company_id)
  select p_line_id, unnest(p_movement_ids), v_company_id;

  update public.bank_statement_lines
  set status = 'matched', created_movement_id = v_fee_movement_id, matched_by = v_user_id, matched_at = now()
  where id = p_line_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('movements', to_jsonb(p_movement_ids), 'fee', v_fee));
end;
$$;

revoke all on function public.confirm_bank_match(uuid, uuid[], numeric) from public;
grant execute on function public.confirm_bank_match(uuid, uuid[], numeric) to authenticated;

-- Línea que está en el banco y no en el sistema: cargarla como movimiento
-- de Tesorería (gasto si salió plata, ajuste de entrada si entró) y dejarla conciliada.
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
  v_movement_id uuid;
begin
  perform public.require_plan('estandar');
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

  insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
  values (
    v_company_id, p_branch_id, v_line.account_id,
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

revoke all on function public.create_movement_from_bank_line(uuid, uuid, text, text) from public;
grant execute on function public.create_movement_from_bank_line(uuid, uuid, text, text) to authenticated;

-- Marcar una línea como "no corresponde" (o volver a pendiente).
create or replace function public.set_bank_line_ignored(p_line_id uuid, p_ignored boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('estandar');
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

revoke all on function public.set_bank_line_ignored(uuid, boolean) from public;
grant execute on function public.set_bank_line_ignored(uuid, boolean) to authenticated;

-- Deshacer una conciliación: la línea vuelve a pendiente, los movimientos
-- quedan libres y se borra el movimiento que había creado la conciliación
-- (comisión o línea cargada desde el banco).
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
  perform public.require_plan('estandar');
  v_company_id := public.reconciliation_caller_company();

  select * into v_line from public.bank_statement_lines where id = p_line_id and company_id = v_company_id for update;
  if not found or v_line.status <> 'matched' then
    raise exception 'Línea inválida o no conciliada';
  end if;

  delete from public.bank_line_matches where line_id = p_line_id;
  update public.bank_statement_lines
  set status = 'pending', created_movement_id = null, matched_by = null, matched_at = null
  where id = p_line_id;
  if v_line.created_movement_id is not null then
    delete from public.treasury_movements where id = v_line.created_movement_id and company_id = v_company_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.undo_match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('deleted_movement_id', v_line.created_movement_id));
end;
$$;

revoke all on function public.undo_bank_match(uuid) from public;
grant execute on function public.undo_bank_match(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('103_bank_reconciliation') on conflict do nothing;
