-- Información contable (plan Full, 2026-10-23, etapa 1 del pedido del dueño:
-- "lo que nos va a pedir ARCA y el contador, como una empresa grande").
--   1. Comprobantes de compra (purchase_vouchers): la factura del proveedor con
--      sus datos fiscales (tipo, punto de venta, número, CUIT, neto e IVA por
--      alícuota, percepciones). Se cargan desde Compras, a mano en Contable o
--      importando "Mis Comprobantes Recibidos" de ARCA. Son el Libro IVA Compras.
--   2. CUIT y condición frente al IVA del proveedor (suppliers.tax_id/tax_condition).
--   3. Escala del monotributo (monotributo_categories), para avisar antes de pasarse.
--   4. accounting_month(mes): todo lo del mes para la pantalla Contable y la
--      carpeta del contador (libros de IVA, posición, gastos, sueldos, saldos).
--   5. Rol "accountant" (Contador): solo mira. La base lo hace cumplir con un
--      trigger por sentencia en cada tabla (accountant_readonly_guard), así no
--      depende de que cada RPC lo revise.
-- Libro IVA Digital: diseño de registros y especificaciones de ARCA (RG 4597,
-- revisión 30/07/2025). Los archivos los arma la web (accounting/libro-iva-digital.ts).

-- ---------------------------------------------------------------- proveedores
alter table public.suppliers
  add column if not exists tax_id text,
  add column if not exists tax_condition text
    check (tax_condition in ('responsable_inscripto', 'monotributo', 'exento', 'consumidor_final'));

create index if not exists suppliers_company_tax_id on public.suppliers (company_id, tax_id) where tax_id is not null;

-- ---------------------------------------------------------------- rol Contador
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'admin', 'manager', 'cashier', 'production', 'readonly', 'accountant'));

-- update_staff_user: se suma 'accountant' a los roles que se pueden asignar,
-- sobre la definición viva de cada base (prod y staging ya divergieron antes).
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p where p.proname = 'update_staff_user' and p.pronamespace = 'public'::regnamespace;
  if v_def is null then
    raise notice 'update_staff_user no existe: se saltea';
    return;
  end if;
  if position('''accountant''' in v_def) > 0 then
    return;
  end if;
  v_new := replace(v_def, '''production'', ''readonly'')', '''production'', ''readonly'', ''accountant'')');
  if v_new = v_def then
    raise exception 'update_staff_user: no se encontró la lista de roles para sumar accountant';
  end if;
  execute v_new;
end $$;

-- El Contador no escribe nada: se corta en la base, para cualquier tabla y
-- cualquier camino (RPC security definer incluido, porque auth.uid() sigue
-- siendo el del usuario). Las funciones de Edge (service role, sin auth.uid())
-- no se ven afectadas.
create or replace function public.accountant_readonly_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and exists (select 1 from public.profiles where id = auth.uid() and role = 'accountant') then
    raise exception 'El usuario Contador solo puede mirar: no puede cargar ni cambiar nada';
  end if;
  return null;
end;
$$;
revoke all on function public.accountant_readonly_guard() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  for v_table in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      -- Lo que se escribe solo al navegar o usar la ayuda.
      and c.relname not in ('page_usage', 'help_chat_usage', 'help_chat_unanswered', 'audit_log', 'schema_migrations')
  loop
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', v_table);
    execute format(
      'create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()',
      v_table
    );
  end loop;
end $$;

-- ---------------------------------------------------------------- monotributo
create table if not exists public.monotributo_categories (
  valid_from date not null,
  category text not null,
  max_income numeric(16,2) not null,
  primary key (valid_from, category)
);
alter table public.monotributo_categories enable row level security;
drop policy if exists monotributo_categories_read on public.monotributo_categories;
create policy monotributo_categories_read on public.monotributo_categories for select to authenticated using (true);

-- ARCA, "Valores de aplicación desde el 1/08/2026" (afip.gob.ar/monotributo/categorias.asp).
insert into public.monotributo_categories (valid_from, category, max_income) values
  ('2026-08-01', 'A', 12009410.45),
  ('2026-08-01', 'B', 17595182.74),
  ('2026-08-01', 'C', 24670494.31),
  ('2026-08-01', 'D', 30628651.43),
  ('2026-08-01', 'E', 36028231.33),
  ('2026-08-01', 'F', 45151659.41),
  ('2026-08-01', 'G', 53995798.87),
  ('2026-08-01', 'H', 81924660.37),
  ('2026-08-01', 'I', 91699761.90),
  ('2026-08-01', 'J', 105012519.20),
  ('2026-08-01', 'K', 126610838.75)
on conflict (valid_from, category) do update set max_income = excluded.max_income;

-- ---------------------------------------------------------------- comprobantes de compra
create table if not exists public.purchase_vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  purchase_id uuid references public.purchases(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  -- Mes del Libro IVA en que se computa (primer día del mes).
  period date not null,
  voucher_date date not null,
  voucher_type integer not null,
  point_of_sale integer not null default 0 check (point_of_sale between 0 and 99999),
  number bigint not null check (number > 0),
  seller_doc_type integer not null default 80,
  seller_doc text not null,
  seller_name text not null,
  -- [{rate, net, vat}] por alícuota. Vacío en B y C (no discriminan IVA).
  vat_lines jsonb not null default '[]'::jsonb,
  net_taxed numeric(14,2) not null default 0,
  vat_total numeric(14,2) not null default 0,
  no_taxed numeric(14,2) not null default 0,
  exempt numeric(14,2) not null default 0,
  perc_vat numeric(14,2) not null default 0,
  perc_iibb numeric(14,2) not null default 0,
  perc_national numeric(14,2) not null default 0,
  perc_municipal numeric(14,2) not null default 0,
  internal_taxes numeric(14,2) not null default 0,
  other_taxes numeric(14,2) not null default 0,
  total numeric(14,2) not null,
  cae text,
  source text not null default 'manual' check (source in ('manual', 'compras', 'arca')),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, seller_doc, voucher_type, point_of_sale, number)
);
create index if not exists purchase_vouchers_period on public.purchase_vouchers (company_id, period);
create unique index if not exists purchase_vouchers_purchase on public.purchase_vouchers (purchase_id) where purchase_id is not null;

alter table public.purchase_vouchers enable row level security;
drop policy if exists purchase_vouchers_read on public.purchase_vouchers;
create policy purchase_vouchers_read on public.purchase_vouchers for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant'))
  );
drop policy if exists plan_full on public.purchase_vouchers;
create policy plan_full on public.purchase_vouchers as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

-- Quién llama. p_write: cargar comprobantes (dueño, admin o encargado, los que
-- ya manejan Compras). Leer: además el Contador.
create or replace function public.accounting_caller(p_write boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('full');
  if auth.uid() is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role
  from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if p_write and v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado carga comprobantes';
  end if;
  if not p_write and v_role not in ('owner', 'admin', 'manager', 'accountant') then
    raise exception 'Solo el dueño, un administrador, un encargado o el contador ve la información contable';
  end if;
  return v_company_id;
end;
$$;
revoke all on function public.accounting_caller(boolean) from public, anon, authenticated;

-- Tipos de comprobante de compra que se aceptan (tabla de ARCA).
create or replace function public.purchase_voucher_type_info(p_type integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_type in (1, 2, 51, 52, 81, 201, 202) then jsonb_build_object('ok', true, 'discriminates', true, 'credit', false)
    when p_type in (3, 53, 203) then jsonb_build_object('ok', true, 'discriminates', true, 'credit', true)
    when p_type in (6, 7, 11, 12, 82, 83, 111, 206, 207, 211, 212) then jsonb_build_object('ok', true, 'discriminates', false, 'credit', false)
    when p_type in (8, 13, 208, 213) then jsonb_build_object('ok', true, 'discriminates', false, 'credit', true)
    else jsonb_build_object('ok', false)
  end;
$$;

-- Alta o cambio de UN comprobante (lo usan save_ e import_). Devuelve
-- {id, status: created|updated|skipped}.
create or replace function public.purchase_voucher_upsert(
  p_company_id uuid,
  p_user_id uuid,
  p jsonb,
  p_source text,
  p_skip_duplicates boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_type integer := (p->>'voucher_type')::integer;
  v_info jsonb;
  v_date date := (p->>'voucher_date')::date;
  v_period date;
  v_doc_type integer := coalesce(nullif(p->>'seller_doc_type', '')::integer, 80);
  v_doc text := regexp_replace(coalesce(p->>'seller_doc', ''), '\D', '', 'g');
  v_name text := nullif(trim(coalesce(p->>'seller_name', '')), '');
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_net numeric := 0;
  v_vat numeric := 0;
  v_parts numeric;
  v_total numeric := round(coalesce((p->>'total')::numeric, 0), 2);
  v_supplier_id uuid := nullif(p->>'supplier_id', '')::uuid;
  v_purchase_id uuid := nullif(p->>'purchase_id', '')::uuid;
  v_branch_id uuid := nullif(p->>'branch_id', '')::uuid;
  v_existing uuid;
  v_status text;
begin
  v_info := public.purchase_voucher_type_info(v_type);
  if v_type is null or not (v_info->>'ok')::boolean then
    raise exception 'Tipo de comprobante no válido para una compra (%)', coalesce(v_type::text, 'vacío');
  end if;
  if v_date is null then raise exception 'Falta la fecha del comprobante'; end if;
  if coalesce((p->>'number')::bigint, 0) <= 0 then raise exception 'Falta el número del comprobante'; end if;
  if v_doc = '' then raise exception 'Falta el CUIT del proveedor'; end if;
  if v_doc_type = 80 and not public.is_valid_cuit(v_doc) then
    raise exception 'El CUIT % no es válido', v_doc;
  end if;
  if v_total <= 0 then raise exception 'El total tiene que ser mayor a cero'; end if;

  v_period := coalesce(nullif(p->>'period', '')::date, v_date);
  v_period := date_trunc('month', v_period)::date;

  if (v_info->>'discriminates')::boolean then
    for v_line in select * from jsonb_array_elements(coalesce(p->'vat_lines', '[]'::jsonb)) loop
      if coalesce((v_line->>'net')::numeric, 0) = 0 and coalesce((v_line->>'vat')::numeric, 0) = 0 then
        continue;
      end if;
      if (v_line->>'rate')::numeric not in (0, 2.5, 5, 10.5, 21, 27) then
        raise exception 'Alícuota de IVA no válida: %', v_line->>'rate';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'rate', (v_line->>'rate')::numeric,
        'net', round((v_line->>'net')::numeric, 2),
        'vat', round(coalesce((v_line->>'vat')::numeric, 0), 2)));
      v_net := v_net + round((v_line->>'net')::numeric, 2);
      v_vat := v_vat + round(coalesce((v_line->>'vat')::numeric, 0), 2);
    end loop;
    v_parts := v_net + v_vat
      + coalesce((p->>'no_taxed')::numeric, 0) + coalesce((p->>'exempt')::numeric, 0)
      + coalesce((p->>'perc_vat')::numeric, 0) + coalesce((p->>'perc_iibb')::numeric, 0)
      + coalesce((p->>'perc_national')::numeric, 0) + coalesce((p->>'perc_municipal')::numeric, 0)
      + coalesce((p->>'internal_taxes')::numeric, 0) + coalesce((p->>'other_taxes')::numeric, 0);
    if abs(v_parts - v_total) > 1 then
      raise exception 'Los importes (%) no suman el total (%)', round(v_parts, 2), v_total;
    end if;
  end if;

  if v_supplier_id is not null and not exists (select 1 from public.suppliers where id = v_supplier_id and company_id = p_company_id) then
    raise exception 'Proveedor inválido';
  end if;
  if v_supplier_id is null then
    select id into v_supplier_id from public.suppliers
    where company_id = p_company_id and tax_id = v_doc
    order by active desc, created_at limit 1;
  end if;
  if v_purchase_id is not null and not exists (select 1 from public.purchases where id = v_purchase_id and company_id = p_company_id) then
    raise exception 'Compra inválida';
  end if;
  if v_branch_id is not null and not exists (select 1 from public.branches where id = v_branch_id and company_id = p_company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if v_name is null then
    select name into v_name from public.suppliers where id = v_supplier_id;
  end if;
  if v_name is null then raise exception 'Falta el nombre del proveedor'; end if;

  if v_id is null then
    select id into v_existing from public.purchase_vouchers
    where company_id = p_company_id and seller_doc = v_doc and voucher_type = v_type
      and point_of_sale = coalesce((p->>'point_of_sale')::integer, 0) and number = (p->>'number')::bigint;
    if v_existing is not null then
      if p_skip_duplicates then
        -- Ya estaba (por ejemplo, cargada desde Compras): se le completa la compra si falta.
        if v_purchase_id is not null then
          update public.purchase_vouchers set purchase_id = v_purchase_id, updated_at = now()
          where id = v_existing and purchase_id is null;
        end if;
        return jsonb_build_object('id', v_existing, 'status', 'skipped');
      end if;
      raise exception 'Ese comprobante ya está cargado';
    end if;
    insert into public.purchase_vouchers (
      company_id, branch_id, purchase_id, supplier_id, period, voucher_date, voucher_type, point_of_sale, number,
      seller_doc_type, seller_doc, seller_name, vat_lines, net_taxed, vat_total, no_taxed, exempt,
      perc_vat, perc_iibb, perc_national, perc_municipal, internal_taxes, other_taxes, total, cae, source, notes, created_by
    ) values (
      p_company_id, v_branch_id, v_purchase_id, v_supplier_id, v_period, v_date, v_type, coalesce((p->>'point_of_sale')::integer, 0), (p->>'number')::bigint,
      v_doc_type, v_doc, left(v_name, 120), v_lines, v_net, v_vat,
      round(coalesce((p->>'no_taxed')::numeric, 0), 2), round(coalesce((p->>'exempt')::numeric, 0), 2),
      round(coalesce((p->>'perc_vat')::numeric, 0), 2), round(coalesce((p->>'perc_iibb')::numeric, 0), 2),
      round(coalesce((p->>'perc_national')::numeric, 0), 2), round(coalesce((p->>'perc_municipal')::numeric, 0), 2),
      round(coalesce((p->>'internal_taxes')::numeric, 0), 2), round(coalesce((p->>'other_taxes')::numeric, 0), 2),
      v_total, nullif(trim(coalesce(p->>'cae', '')), ''), p_source, nullif(trim(coalesce(p->>'notes', '')), ''), p_user_id
    )
    returning id into v_id;
    v_status := 'created';
  else
    update public.purchase_vouchers set
      branch_id = v_branch_id, purchase_id = v_purchase_id, supplier_id = v_supplier_id, period = v_period,
      voucher_date = v_date, voucher_type = v_type, point_of_sale = coalesce((p->>'point_of_sale')::integer, 0),
      number = (p->>'number')::bigint, seller_doc_type = v_doc_type, seller_doc = v_doc, seller_name = left(v_name, 120),
      vat_lines = v_lines, net_taxed = v_net, vat_total = v_vat,
      no_taxed = round(coalesce((p->>'no_taxed')::numeric, 0), 2), exempt = round(coalesce((p->>'exempt')::numeric, 0), 2),
      perc_vat = round(coalesce((p->>'perc_vat')::numeric, 0), 2), perc_iibb = round(coalesce((p->>'perc_iibb')::numeric, 0), 2),
      perc_national = round(coalesce((p->>'perc_national')::numeric, 0), 2), perc_municipal = round(coalesce((p->>'perc_municipal')::numeric, 0), 2),
      internal_taxes = round(coalesce((p->>'internal_taxes')::numeric, 0), 2), other_taxes = round(coalesce((p->>'other_taxes')::numeric, 0), 2),
      total = v_total, cae = nullif(trim(coalesce(p->>'cae', '')), ''), notes = nullif(trim(coalesce(p->>'notes', '')), ''), updated_at = now()
    where id = v_id and company_id = p_company_id;
    if not found then raise exception 'Comprobante inválido'; end if;
    v_status := 'updated';
  end if;

  -- El proveedor vinculado guarda su CUIT si todavía no lo tenía.
  if v_supplier_id is not null and v_doc_type = 80 then
    update public.suppliers set tax_id = v_doc where id = v_supplier_id and tax_id is null;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status);
end;
$$;
revoke all on function public.purchase_voucher_upsert(uuid, uuid, jsonb, text, boolean) from public, anon, authenticated;

create or replace function public.save_purchase_voucher(p_voucher jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_res jsonb;
  v_source text := case when nullif(p_voucher->>'purchase_id', '') is not null then 'compras' else 'manual' end;
begin
  v_res := public.purchase_voucher_upsert(v_company_id, auth.uid(), p_voucher, v_source, false);
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'purchase_voucher.' || (v_res->>'status'), 'purchase_voucher', v_res->>'id',
          jsonb_build_object('type', p_voucher->>'voucher_type', 'number', p_voucher->>'number', 'total', p_voucher->>'total', 'seller_doc', p_voucher->>'seller_doc'));
  return (v_res->>'id')::uuid;
end;
$$;

create or replace function public.delete_purchase_voucher(p_voucher_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_row public.purchase_vouchers%rowtype;
begin
  select * into v_row from public.purchase_vouchers where id = p_voucher_id and company_id = v_company_id for update;
  if v_row.id is null then raise exception 'Comprobante inválido'; end if;
  delete from public.purchase_vouchers where id = v_row.id;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, auth.uid(), 'purchase_voucher.delete', 'purchase_voucher', v_row.id::text, to_jsonb(v_row));
end;
$$;

-- Importar "Mis Comprobantes Recibidos": los repetidos se saltean; cada fila
-- con error se informa y no frena a las demás.
create or replace function public.import_purchase_vouchers(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_row jsonb;
  v_res jsonb;
  v_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_i integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Formato inválido'; end if;
  if jsonb_array_length(p_rows) > 3000 then raise exception 'Son demasiadas filas: subí hasta 3000 por vez'; end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      v_res := public.purchase_voucher_upsert(v_company_id, auth.uid(), v_row, 'arca', true);
      if v_res->>'status' = 'created' then v_created := v_created + 1; else v_skipped := v_skipped + 1; end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', coalesce((v_row->>'row')::integer, v_i), 'error', sqlerrm));
    end;
  end loop;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'purchase_voucher.import', 'purchase_voucher', null,
          jsonb_build_object('created', v_created, 'skipped', v_skipped, 'errors', jsonb_array_length(v_errors)));
  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'errors', v_errors);
end;
$$;

create or replace function public.set_supplier_tax(p_supplier_id uuid, p_tax_id text, p_tax_condition text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_doc text := nullif(regexp_replace(coalesce(p_tax_id, ''), '\D', '', 'g'), '');
begin
  if auth.uid() is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company_id from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_doc is not null and not public.is_valid_cuit(v_doc) then
    raise exception 'El CUIT % no es válido', v_doc;
  end if;
  if p_tax_condition is not null and p_tax_condition not in ('responsable_inscripto', 'monotributo', 'exento', 'consumidor_final') then
    raise exception 'Condición frente al IVA inválida';
  end if;
  update public.suppliers set tax_id = v_doc, tax_condition = p_tax_condition
  where id = p_supplier_id and company_id = v_company_id;
  if not found then raise exception 'Proveedor inválido'; end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'supplier.tax', 'supplier', p_supplier_id::text,
          jsonb_build_object('tax_id', v_doc, 'tax_condition', p_tax_condition));
end;
$$;

-- ---------------------------------------------------------------- el mes completo
-- Todo lo que la pantalla Contable y la carpeta del contador necesitan de un mes.
-- Saldos de cuentas: al último día del mes. Clientes, proveedores, deudas,
-- cheques y stock: a hoy (el sistema no guarda su historia día por día).
create or replace function public.accounting_month(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(false);
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_12_from date := (date_trunc('month', p_month) - interval '11 months')::date;
  v_result jsonb;
begin
  select jsonb_build_object(
    'period', v_from,
    'period_end', v_to,
    'company', (
      select jsonb_build_object('name', c.name, 'cuit', f.cuit, 'business_name', f.business_name,
                                'tax_condition', f.tax_condition, 'point_of_sale', f.point_of_sale,
                                'invoicing_enabled', coalesce(f.enabled, false))
      from public.companies c left join public.company_fiscal_settings f on f.company_id = c.id
      where c.id = v_company_id),
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'date', coalesce(i.issued_on, (i.authorized_at at time zone 'America/Argentina/Buenos_Aires')::date),
        'voucher_type', i.voucher_type, 'point_of_sale', i.point_of_sale, 'number', i.number, 'letter', i.letter,
        'doc_type', i.customer_doc_type, 'doc', i.customer_doc_number, 'name', i.customer_name,
        'total', i.total, 'net', i.net, 'vat', i.vat, 'vat_rate', i.vat_rate, 'vat_lines', i.vat_breakdown)
        order by coalesce(i.issued_on, i.authorized_at::date), i.voucher_type, i.number)
      from public.invoices i
      where i.company_id = v_company_id and i.status = 'autorizada' and i.number is not null
        and coalesce(i.issued_on, (i.authorized_at at time zone 'America/Argentina/Buenos_Aires')::date) between v_from and v_to), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(to_jsonb(v) || jsonb_build_object('supplier_name', s.name) order by v.voucher_date, v.seller_name, v.number)
      from public.purchase_vouchers v left join public.suppliers s on s.id = v.supplier_id
      where v.company_id = v_company_id and v.period = v_from), '[]'::jsonb),
    'purchases_without_voucher', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'date', p.purchase_date, 'supplier_id', p.supplier_id, 'supplier', s.name,
                                          'supplier_tax_id', s.tax_id, 'invoice_number', p.invoice_number, 'total', p.total)
                       order by p.purchase_date)
      from public.purchases p left join public.suppliers s on s.id = p.supplier_id
      where p.company_id = v_company_id and p.status = 'active' and p.purchase_date between v_from and v_to
        and not exists (select 1 from public.purchase_vouchers v where v.purchase_id = p.id)), '[]'::jsonb),
    'monotributo', jsonb_build_object(
      'from', v_12_from,
      'to', v_to,
      -- Lo facturado electrónicamente (Factura C menos sus notas de crédito).
      'invoiced_12m', coalesce((
        select sum(case when i.voucher_type in (13, 8, 3) then -i.total else i.total end)
        from public.invoices i
        where i.company_id = v_company_id and i.status = 'autorizada'
          and coalesce(i.issued_on, i.authorized_at::date) between v_12_from and v_to), 0),
      -- Todas las ventas cargadas en el sistema (Mostrador y a cuenta), con o sin factura.
      'sales_12m', coalesce((
        select sum(s.total) from public.pos_sales s
        where s.company_id = v_company_id and s.voided_at is null
          and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between v_12_from and v_to), 0)
        + coalesce((
        select sum(ch.amount) from public.customer_charges ch
        where ch.company_id = v_company_id and ch.charge_date between v_12_from and v_to), 0),
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object('category', m.category, 'max_income', m.max_income) order by m.max_income)
        from public.monotributo_categories m
        where m.valid_from = (select max(valid_from) from public.monotributo_categories where valid_from <= greatest(v_to, current_date))), '[]'::jsonb),
      'categories_from', (select max(valid_from) from public.monotributo_categories where valid_from <= greatest(v_to, current_date))
    ),
    'month_sales', jsonb_build_object(
      'pos', coalesce((select sum(s.total) from public.pos_sales s where s.company_id = v_company_id and s.voided_at is null
                       and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between v_from and v_to), 0),
      'account', coalesce((select sum(ch.amount) from public.customer_charges ch where ch.company_id = v_company_id
                           and ch.charge_date between v_from and v_to), 0)
    ),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'total', total) order by total desc)
      from (select coalesce(nullif(trim(m.category), ''), 'Sin categoría') as category, sum(m.amount) as total
            from public.treasury_movements m
            where m.company_id = v_company_id and m.movement_type = 'gasto' and m.direction = 'out'
              and m.occurred_on between v_from and v_to
            group by 1) g), '[]'::jsonb),
    'payroll', jsonb_build_object(
      'salaries', coalesce((select sum(m.amount) from public.treasury_movements m where m.company_id = v_company_id
                            and m.movement_type = 'sueldo' and m.direction = 'out' and m.occurred_on between v_from and v_to), 0),
      'advances', coalesce((select sum(m.amount) from public.treasury_movements m where m.company_id = v_company_id
                            and m.movement_type in ('vale_adelanto', 'vale_mercaderia') and m.direction = 'out' and m.occurred_on between v_from and v_to), 0)
    ),
    'supplier_payments', coalesce((select sum(m.amount) from public.treasury_movements m where m.company_id = v_company_id
                                   and m.movement_type = 'pago_proveedor' and m.direction = 'out' and m.occurred_on between v_from and v_to), 0),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.name, 'kind', coalesce(a.cheque_role, case when a.is_safe then 'caja_fuerte' else a.payment_method end),
             'balance', a.initial_balance + coalesce((
               select sum(case when m.direction = 'in' then m.amount else -m.amount end)
               from public.treasury_movements m where m.account_id = a.id and m.occurred_on <= v_to), 0))
             order by a.name)
      from public.treasury_accounts a where a.company_id = v_company_id and a.active), '[]'::jsonb),
    'receivables', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'tax_id', c.tax_id, 'balance', b.balance) order by b.balance desc)
      from public.customer_balance b join public.customers c on c.id = b.customer_id
      where b.company_id = v_company_id and abs(b.balance) >= 0.01), '[]'::jsonb),
    'payables', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'tax_id', s.tax_id, 'balance', b.balance) order by b.balance desc)
      from public.supplier_balance b join public.suppliers s on s.id = b.supplier_id
      where b.company_id = v_company_id and abs(b.balance) >= 0.01), '[]'::jsonb),
    'debts', coalesce((
      select jsonb_agg(jsonb_build_object('name', cr.name, 'balance', b.balance) order by b.balance desc)
      from public.creditor_balance b join public.creditors cr on cr.id = b.creditor_id
      where b.company_id = v_company_id and abs(b.balance) >= 0.01), '[]'::jsonb),
    'cheques', coalesce((
      select jsonb_agg(jsonb_build_object('kind', ch.kind, 'status', ch.status, 'number', ch.number, 'bank', ch.bank,
                                          'drawer', ch.drawer_name, 'amount', ch.amount, 'pay_date', ch.pay_date) order by ch.pay_date)
      from public.cheques ch
      where ch.company_id = v_company_id and ch.status in ('in_portfolio', 'pending')), '[]'::jsonb),
    'stock', coalesce((
      select jsonb_agg(jsonb_build_object('branch', b.name, 'value', x.value) order by b.name)
      from (select ps.branch_id, sum(greatest(ps.stock, 0) * ps.cost) as value
            from public.products_with_stock ps
            where ps.company_id = v_company_id and ps.stock_source_id is null and coalesce(ps.active, true)
            group by ps.branch_id) x
      join public.branches b on b.id = x.branch_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.purchase_voucher_type_info(integer) from public, anon;
grant execute on function public.purchase_voucher_type_info(integer) to authenticated;
revoke all on function public.save_purchase_voucher(jsonb) from public, anon;
grant execute on function public.save_purchase_voucher(jsonb) to authenticated;
revoke all on function public.delete_purchase_voucher(uuid) from public, anon;
grant execute on function public.delete_purchase_voucher(uuid) to authenticated;
revoke all on function public.import_purchase_vouchers(jsonb) from public, anon;
grant execute on function public.import_purchase_vouchers(jsonb) to authenticated;
revoke all on function public.set_supplier_tax(uuid, text, text) from public, anon;
grant execute on function public.set_supplier_tax(uuid, text, text) to authenticated;
revoke all on function public.accounting_month(date) from public, anon;
grant execute on function public.accounting_month(date) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('155_accounting') on conflict do nothing;
