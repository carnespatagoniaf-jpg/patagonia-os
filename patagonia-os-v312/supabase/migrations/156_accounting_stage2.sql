-- Contable, segunda tanda (2026-10-23, pedido del dueño: "agregá los 5 puntos"):
--   1. Foto o PDF de la factura del proveedor (Storage "purchase-docs", privado,
--      carpeta por empresa) → purchase_vouchers.attachment_path.
--   2. Ingresos Brutos: régimen, jurisdicciones con alícuota y coeficiente,
--      base (facturado o todas las ventas) y créditos cargados a mano
--      (iibb_credits). Las percepciones de las facturas de compra y las
--      retenciones del banco (SIRCREB) se toman solas en accounting_month.
--   3. Vencimientos: fechas oficiales de ARCA por terminación de CUIT
--      (official_due_dates, las carga el equipo cada mes cuando ARCA las
--      publica) + recordatorios propios del negocio (tax_reminders).
--   4. Antigüedad de saldos de clientes y proveedores (accounting_aging): lo
--      que se debe repartido en 0-30, 31-60, 61-90 y más de 90 días, cobrando
--      siempre primero lo más viejo.
--   5. Inventario al cierre (inventory_snapshots/_items): el stock valorizado a
--      una fecha, que queda guardado para el balance.
-- Todo es plan Full. El Contador (migración 155) mira y no escribe: las tablas
-- nuevas también llevan el trigger zz_accountant_readonly.

-- Mensajes más claros (el Contador recibía "carga comprobantes" en cualquier acción).
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
  if p_write and v_role = 'accountant' then
    raise exception 'El usuario Contador solo puede mirar: no puede cargar ni cambiar nada';
  end if;
  if p_write and v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Esto lo hace el dueño, un administrador o un encargado';
  end if;
  if not p_write and v_role not in ('owner', 'admin', 'manager', 'accountant') then
    raise exception 'Solo el dueño, un administrador, un encargado o el contador ve la información contable';
  end if;
  return v_company_id;
end;
$$;
revoke all on function public.accounting_caller(boolean) from public, anon, authenticated;

-- ------------------------------------------------------------ 1. adjuntos
alter table public.purchase_vouchers add column if not exists attachment_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-docs', 'purchase-docs', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- La primera carpeta del archivo es el id de la empresa.
drop policy if exists purchase_docs_read on storage.objects;
create policy purchase_docs_read on storage.objects for select to authenticated
  using (
    bucket_id = 'purchase-docs'
    and (storage.foldername(name))[1] = public.current_company_id()::text
    and public.company_plan_allows('full')
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin', 'manager', 'accountant'))
  );
drop policy if exists purchase_docs_insert on storage.objects;
create policy purchase_docs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'purchase-docs'
    and (storage.foldername(name))[1] = public.current_company_id()::text
    and public.company_plan_allows('full')
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin', 'manager'))
  );
drop policy if exists purchase_docs_delete on storage.objects;
create policy purchase_docs_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'purchase-docs'
    and (storage.foldername(name))[1] = public.current_company_id()::text
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin', 'manager'))
  );

create or replace function public.set_purchase_voucher_attachment(p_voucher_id uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
begin
  if p_path is not null and p_path not like v_company_id::text || '/' || p_voucher_id::text || '/%' then
    raise exception 'Archivo inválido';
  end if;
  update public.purchase_vouchers set attachment_path = p_path, updated_at = now()
  where id = p_voucher_id and company_id = v_company_id;
  if not found then raise exception 'Comprobante inválido'; end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), case when p_path is null then 'purchase_voucher.detach' else 'purchase_voucher.attach' end,
          'purchase_voucher', p_voucher_id::text, jsonb_build_object('path', p_path));
end;
$$;

-- ------------------------------------------------------------ 2 y 3. impuestos del negocio
create table if not exists public.company_tax_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  -- Obligaciones nacionales que se le recuerdan (null = según su condición: monotributo o IVA).
  obligations text[],
  iibb_regime text not null default 'local' check (iibb_regime in ('local', 'convenio', 'simplificado', 'exento')),
  -- [{name, rate, coefficient}] (coeficiente solo en Convenio Multilateral).
  iibb_jurisdictions jsonb not null default '[]'::jsonb,
  -- Base imponible: lo facturado a ARCA (sin IVA) o todas las ventas del sistema.
  iibb_base text not null default 'invoiced' check (iibb_base in ('invoiced', 'sales')),
  iibb_due_day integer check (iibb_due_day between 1 and 31),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.company_tax_settings enable row level security;
drop policy if exists company_tax_settings_read on public.company_tax_settings;
create policy company_tax_settings_read on public.company_tax_settings for select to authenticated
  using (company_id = public.current_company_id()
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant')));
drop policy if exists plan_full on public.company_tax_settings;
create policy plan_full on public.company_tax_settings as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

create table if not exists public.iibb_credits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  period date not null,
  kind text not null check (kind in ('retencion', 'percepcion', 'saldo_a_favor', 'otro')),
  jurisdiction text,
  amount numeric(14,2) not null check (amount > 0),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists iibb_credits_period on public.iibb_credits (company_id, period);
alter table public.iibb_credits enable row level security;
drop policy if exists iibb_credits_read on public.iibb_credits;
create policy iibb_credits_read on public.iibb_credits for select to authenticated
  using (company_id = public.current_company_id()
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant')));
drop policy if exists plan_full on public.iibb_credits;
create policy plan_full on public.iibb_credits as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

-- Calendario oficial de ARCA (lo carga el equipo de Patagonia OS cada mes).
create table if not exists public.official_due_dates (
  month date not null,
  obligation text not null check (obligation in ('iva', 'monotributo', 'empleadores', 'autonomos', 'ganancias_anticipo')),
  -- Terminaciones de CUIT, por ejemplo '0-1' o '0-1-2-3'; 'todos' = cualquiera.
  digits text not null,
  due_date date not null,
  primary key (month, obligation, digits)
);
alter table public.official_due_dates enable row level security;
drop policy if exists official_due_dates_read on public.official_due_dates;
create policy official_due_dates_read on public.official_due_dates for select to authenticated using (true);

-- argentina.gob.ar/arca/vencimientos, octubre 2026.
insert into public.official_due_dates (month, obligation, digits, due_date) values
  ('2026-10-01', 'iva', '0-1', '2026-10-19'),
  ('2026-10-01', 'iva', '2-3', '2026-10-20'),
  ('2026-10-01', 'iva', '4-5', '2026-10-21'),
  ('2026-10-01', 'iva', '6-7', '2026-10-22'),
  ('2026-10-01', 'iva', '8-9', '2026-10-23'),
  ('2026-10-01', 'monotributo', 'todos', '2026-10-20'),
  ('2026-10-01', 'empleadores', '0-1-2-3', '2026-10-09'),
  ('2026-10-01', 'empleadores', '4-5-6', '2026-10-13'),
  ('2026-10-01', 'empleadores', '7-8-9', '2026-10-14'),
  ('2026-10-01', 'autonomos', '0-1-2-3', '2026-10-05'),
  ('2026-10-01', 'autonomos', '4-5-6', '2026-10-06'),
  ('2026-10-01', 'autonomos', '7-8-9', '2026-10-07')
on conflict (month, obligation, digits) do update set due_date = excluded.due_date;

create table if not exists public.tax_reminders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 80),
  day_of_month integer not null check (day_of_month between 1 and 31),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.tax_reminders enable row level security;
drop policy if exists tax_reminders_read on public.tax_reminders;
create policy tax_reminders_read on public.tax_reminders for select to authenticated
  using (company_id = public.current_company_id()
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant')));
drop policy if exists plan_full on public.tax_reminders;
create policy plan_full on public.tax_reminders as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

create or replace function public.save_company_tax_settings(p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_obligations text[];
  v_juris jsonb := '[]'::jsonb;
  v_j jsonb;
  v_coef_total numeric := 0;
  v_regime text := coalesce(p_settings->>'iibb_regime', 'local');
begin
  if p_settings ? 'obligations' and jsonb_typeof(p_settings->'obligations') = 'array' then
    select array_agg(x) into v_obligations from jsonb_array_elements_text(p_settings->'obligations') x;
    if exists (select 1 from unnest(coalesce(v_obligations, '{}')) o where o not in ('iva', 'monotributo', 'empleadores', 'autonomos', 'ganancias_anticipo')) then
      raise exception 'Obligación desconocida';
    end if;
    v_obligations := coalesce(v_obligations, '{}');
  end if;
  for v_j in select * from jsonb_array_elements(coalesce(p_settings->'iibb_jurisdictions', '[]'::jsonb)) loop
    if nullif(trim(coalesce(v_j->>'name', '')), '') is null then raise exception 'Falta el nombre de la jurisdicción'; end if;
    if coalesce((v_j->>'rate')::numeric, -1) < 0 or (v_j->>'rate')::numeric > 20 then raise exception 'La alícuota de Ingresos Brutos tiene que estar entre 0 y 20%%'; end if;
    v_juris := v_juris || jsonb_build_array(jsonb_build_object(
      'name', trim(v_j->>'name'), 'rate', round((v_j->>'rate')::numeric, 4),
      'coefficient', round(coalesce(nullif(v_j->>'coefficient', '')::numeric, 1), 4)));
    v_coef_total := v_coef_total + coalesce(nullif(v_j->>'coefficient', '')::numeric, 1);
  end loop;
  if v_regime = 'convenio' and jsonb_array_length(v_juris) > 0 and abs(v_coef_total - 1) > 0.001 then
    raise exception 'En Convenio Multilateral los coeficientes tienen que sumar 1 (suman %)', round(v_coef_total, 4);
  end if;
  insert into public.company_tax_settings (company_id, obligations, iibb_regime, iibb_jurisdictions, iibb_base, iibb_due_day, updated_by, updated_at)
  values (v_company_id, v_obligations, v_regime, v_juris, coalesce(p_settings->>'iibb_base', 'invoiced'),
          nullif(p_settings->>'iibb_due_day', '')::integer, auth.uid(), now())
  on conflict (company_id) do update set
    obligations = case when p_settings ? 'obligations' then excluded.obligations else company_tax_settings.obligations end,
    iibb_regime = excluded.iibb_regime, iibb_jurisdictions = excluded.iibb_jurisdictions,
    iibb_base = excluded.iibb_base, iibb_due_day = excluded.iibb_due_day,
    updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'tax_settings.save', 'company', v_company_id::text, p_settings);
end;
$$;

create or replace function public.add_iibb_credit(p_period date, p_kind text, p_jurisdiction text, p_amount numeric, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'El importe tiene que ser mayor a cero'; end if;
  insert into public.iibb_credits (company_id, period, kind, jurisdiction, amount, notes, created_by)
  values (v_company_id, date_trunc('month', p_period)::date, p_kind, nullif(trim(coalesce(p_jurisdiction, '')), ''), round(p_amount, 2),
          nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'iibb_credit.add', 'iibb_credit', v_id::text, jsonb_build_object('period', p_period, 'kind', p_kind, 'amount', p_amount));
  return v_id;
end;
$$;

create or replace function public.delete_iibb_credit(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_row public.iibb_credits%rowtype;
begin
  delete from public.iibb_credits where id = p_id and company_id = v_company_id returning * into v_row;
  if v_row.id is null then raise exception 'Crédito inválido'; end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, auth.uid(), 'iibb_credit.delete', 'iibb_credit', p_id::text, to_jsonb(v_row));
end;
$$;

create or replace function public.save_tax_reminder(p_id uuid, p_title text, p_day integer, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_id uuid := p_id;
begin
  if nullif(trim(coalesce(p_title, '')), '') is null then raise exception 'Poné qué hay que pagar'; end if;
  if p_day is null or p_day < 1 or p_day > 31 then raise exception 'El día tiene que estar entre 1 y 31'; end if;
  if v_id is null then
    insert into public.tax_reminders (company_id, title, day_of_month, active, created_by)
    values (v_company_id, left(trim(p_title), 80), p_day, coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    update public.tax_reminders set title = left(trim(p_title), 80), day_of_month = p_day, active = coalesce(p_active, true)
    where id = v_id and company_id = v_company_id;
    if not found then raise exception 'Recordatorio inválido'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_tax_reminder(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
begin
  delete from public.tax_reminders where id = p_id and company_id = v_company_id;
  if not found then raise exception 'Recordatorio inválido'; end if;
end;
$$;

-- ------------------------------------------------------------ 4. antigüedad de saldos
-- Lo pagado se aplica primero a lo más viejo (FIFO). Lo que queda de cada
-- venta/compra se ubica según los días que pasaron desde su fecha.
create or replace function public.accounting_aging(p_as_of date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(false);
  v_as_of date := coalesce(p_as_of, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
begin
  return jsonb_build_object(
    'as_of', v_as_of,
    'receivables', coalesce((
      with bal as (
        select b.customer_id as id, b.balance, b.total_charged - b.balance as paid
        from public.customer_balance b
        where b.company_id = v_company_id and b.balance >= 0.01
      ), docs as (
        select c.customer_id as id, c.charge_date as d, c.amount,
               sum(c.amount) over (partition by c.customer_id order by c.charge_date, c.created_at, c.id) as cum
        from public.customer_charges c
        where c.company_id = v_company_id and c.customer_id in (select id from bal)
      ), open as (
        select d.id, d.d, greatest(0, least(d.amount, d.cum - b.paid)) as open_amount
        from docs d join bal b on b.id = d.id
      ), agg as (
        select o.id,
          sum(case when v_as_of - o.d <= 30 then o.open_amount else 0 end) as b0,
          sum(case when v_as_of - o.d between 31 and 60 then o.open_amount else 0 end) as b31,
          sum(case when v_as_of - o.d between 61 and 90 then o.open_amount else 0 end) as b61,
          sum(case when v_as_of - o.d > 90 then o.open_amount else 0 end) as b91,
          min(o.d) filter (where o.open_amount > 0) as oldest
        from open o group by o.id
      )
      select jsonb_agg(jsonb_build_object(
        'name', cu.name, 'tax_id', cu.tax_id, 'phone', cu.phone, 'balance', b.balance,
        'b0_30', coalesce(a.b0, 0) + greatest(0, b.balance - coalesce(a.b0 + a.b31 + a.b61 + a.b91, 0)),
        'b31_60', coalesce(a.b31, 0), 'b61_90', coalesce(a.b61, 0), 'b90', coalesce(a.b91, 0), 'oldest', a.oldest)
        order by coalesce(a.b91, 0) desc, b.balance desc)
      from bal b join public.customers cu on cu.id = b.id left join agg a on a.id = b.id), '[]'::jsonb),
    'payables', coalesce((
      with bal as (
        select b.supplier_id as id, b.balance, b.total_purchases - b.balance as paid
        from public.supplier_balance b
        where b.company_id = v_company_id and b.balance >= 0.01
      ), docs as (
        select p.supplier_id as id, p.purchase_date as d, p.total as amount,
               sum(p.total) over (partition by p.supplier_id order by p.purchase_date, p.created_at, p.id) as cum
        from public.purchases p
        where p.company_id = v_company_id and p.status = 'active' and p.supplier_id in (select id from bal)
      ), open as (
        select d.id, d.d, greatest(0, least(d.amount, d.cum - b.paid)) as open_amount
        from docs d join bal b on b.id = d.id
      ), agg as (
        select o.id,
          sum(case when v_as_of - o.d <= 30 then o.open_amount else 0 end) as b0,
          sum(case when v_as_of - o.d between 31 and 60 then o.open_amount else 0 end) as b31,
          sum(case when v_as_of - o.d between 61 and 90 then o.open_amount else 0 end) as b61,
          sum(case when v_as_of - o.d > 90 then o.open_amount else 0 end) as b91,
          min(o.d) filter (where o.open_amount > 0) as oldest
        from open o group by o.id
      )
      select jsonb_agg(jsonb_build_object(
        'name', s.name, 'tax_id', s.tax_id, 'phone', s.phone, 'balance', b.balance,
        'b0_30', coalesce(a.b0, 0) + greatest(0, b.balance - coalesce(a.b0 + a.b31 + a.b61 + a.b91, 0)),
        'b31_60', coalesce(a.b31, 0), 'b61_90', coalesce(a.b61, 0), 'b90', coalesce(a.b91, 0), 'oldest', a.oldest)
        order by coalesce(a.b91, 0) desc, b.balance desc)
      from bal b join public.suppliers s on s.id = b.id left join agg a on a.id = b.id), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------ 5. inventario al cierre
create table if not exists public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  taken_on date not null,
  label text,
  total_value numeric(16,2) not null default 0,
  items_count integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.inventory_snapshot_items (
  snapshot_id uuid not null references public.inventory_snapshots(id) on delete cascade,
  branch_id uuid not null,
  branch_name text not null,
  product_id uuid,
  code text,
  name text not null,
  category text,
  unit text,
  quantity numeric(14,3) not null,
  unit_cost numeric(14,2) not null,
  value numeric(16,2) not null
);
create index if not exists inventory_snapshot_items_snapshot on public.inventory_snapshot_items (snapshot_id);
alter table public.inventory_snapshots enable row level security;
alter table public.inventory_snapshot_items enable row level security;
drop policy if exists inventory_snapshots_read on public.inventory_snapshots;
create policy inventory_snapshots_read on public.inventory_snapshots for select to authenticated
  using (company_id = public.current_company_id()
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant')));
drop policy if exists plan_full on public.inventory_snapshots;
create policy plan_full on public.inventory_snapshots as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));
drop policy if exists inventory_snapshot_items_read on public.inventory_snapshot_items;
create policy inventory_snapshot_items_read on public.inventory_snapshot_items for select to authenticated
  using (exists (select 1 from public.inventory_snapshots s where s.id = snapshot_id and s.company_id = public.current_company_id())
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin', 'manager', 'accountant')));
drop policy if exists plan_full on public.inventory_snapshot_items;
create policy plan_full on public.inventory_snapshot_items as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

-- Stock al final del día p_date (suma de movimientos hasta ese día, hora
-- argentina), valorizado al costo actual de cada producto. Las presentaciones
-- no van: su stock está en el principal.
create or replace function public.take_inventory_snapshot(p_date date, p_label text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_role text;
  v_id uuid;
  v_until timestamptz;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role not in ('owner', 'admin') then raise exception 'El inventario al cierre lo guarda el dueño o un administrador'; end if;
  if p_date is null or p_date > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception 'La fecha no puede ser futura';
  end if;
  v_until := ((p_date + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');

  insert into public.inventory_snapshots (company_id, taken_on, label, created_by)
  values (v_company_id, p_date, nullif(trim(coalesce(p_label, '')), ''), auth.uid())
  returning id into v_id;

  insert into public.inventory_snapshot_items (snapshot_id, branch_id, branch_name, product_id, code, name, category, unit, quantity, unit_cost, value)
  select v_id, b.id, b.name, p.id, p.code, p.name, pc.name, p.unit, s.qty, coalesce(p.cost, 0), round(greatest(s.qty, 0) * coalesce(p.cost, 0), 2)
  from (
    select m.branch_id, m.product_id, sum(m.quantity) as qty
    from public.inventory_movements m
    where m.company_id = v_company_id and m.created_at < v_until
    group by m.branch_id, m.product_id
  ) s
  join public.products p on p.id = s.product_id and p.company_id = v_company_id and p.stock_source_id is null
  join public.branches b on b.id = s.branch_id
  left join public.product_categories pc on pc.id = p.category_id
  where s.qty <> 0;

  update public.inventory_snapshots
  set total_value = coalesce((select sum(value) from public.inventory_snapshot_items where snapshot_id = v_id), 0),
      items_count = (select count(*) from public.inventory_snapshot_items where snapshot_id = v_id)
  where id = v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'inventory_snapshot.take', 'inventory_snapshot', v_id::text, jsonb_build_object('date', p_date, 'label', p_label));
  return v_id;
end;
$$;

create or replace function public.delete_inventory_snapshot(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.accounting_caller(true);
  v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador borra un inventario'; end if;
  delete from public.inventory_snapshots where id = p_id and company_id = v_company_id;
  if not found then raise exception 'Inventario inválido'; end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id)
  values (v_company_id, auth.uid(), 'inventory_snapshot.delete', 'inventory_snapshot', p_id::text);
end;
$$;

-- ------------------------------------------------------------ accounting_month + IIBB
-- Mismo cuerpo que la migración 155, con el bloque 'iibb' agregado al final.
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
                                'invoicing_enabled', coalesce(f.enabled, false), 'default_vat_rate', f.default_vat_rate)
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
      'invoiced_12m', coalesce((
        select sum(case when i.voucher_type in (13, 8, 3) then -i.total else i.total end)
        from public.invoices i
        where i.company_id = v_company_id and i.status = 'autorizada'
          and coalesce(i.issued_on, i.authorized_at::date) between v_12_from and v_to), 0),
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
      join public.branches b on b.id = x.branch_id), '[]'::jsonb),
    'iibb', jsonb_build_object(
      'settings', (select to_jsonb(t) - 'company_id' - 'updated_by' from public.company_tax_settings t where t.company_id = v_company_id),
      'perceptions', coalesce((select sum(case when v.voucher_type in (3, 8, 13, 53, 203, 208, 213) then -v.perc_iibb else v.perc_iibb end)
                               from public.purchase_vouchers v where v.company_id = v_company_id and v.period = v_from), 0),
      -- Retenciones del banco (SIRCREB) en los resúmenes subidos a Conciliación.
      'bank_withholdings', coalesce((
        select sum(-l.amount) from public.bank_statement_lines l
        where l.company_id = v_company_id and l.amount < 0 and l.line_date between v_from and v_to
          and l.description ~* '(sircreb|ing\.? ?brutos|ingresos brutos|iibb|reg\.? ?recaud)'), 0),
      'bank_withholding_lines', coalesce((
        select count(*) from public.bank_statement_lines l
        where l.company_id = v_company_id and l.amount < 0 and l.line_date between v_from and v_to
          and l.description ~* '(sircreb|ing\.? ?brutos|ingresos brutos|iibb|reg\.? ?recaud)'), 0),
      'credits', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'jurisdiction', c.jurisdiction, 'amount', c.amount, 'notes', c.notes) order by c.created_at)
        from public.iibb_credits c where c.company_id = v_company_id and c.period = v_from), '[]'::jsonb)
    )
  ) into v_result;
  return v_result;
end;
$$;

-- ------------------------------------------------------------ Contador y permisos
do $$
declare
  v_table text;
begin
  foreach v_table in array array['company_tax_settings', 'iibb_credits', 'official_due_dates', 'tax_reminders', 'inventory_snapshots', 'inventory_snapshot_items'] loop
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', v_table);
    execute format(
      'create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()',
      v_table
    );
  end loop;
end $$;

revoke all on function public.set_purchase_voucher_attachment(uuid, text) from public, anon;
grant execute on function public.set_purchase_voucher_attachment(uuid, text) to authenticated;
revoke all on function public.save_company_tax_settings(jsonb) from public, anon;
grant execute on function public.save_company_tax_settings(jsonb) to authenticated;
revoke all on function public.add_iibb_credit(date, text, text, numeric, text) from public, anon;
grant execute on function public.add_iibb_credit(date, text, text, numeric, text) to authenticated;
revoke all on function public.delete_iibb_credit(uuid) from public, anon;
grant execute on function public.delete_iibb_credit(uuid) to authenticated;
revoke all on function public.save_tax_reminder(uuid, text, integer, boolean) from public, anon;
grant execute on function public.save_tax_reminder(uuid, text, integer, boolean) to authenticated;
revoke all on function public.delete_tax_reminder(uuid) from public, anon;
grant execute on function public.delete_tax_reminder(uuid) to authenticated;
revoke all on function public.accounting_aging(date) from public, anon;
grant execute on function public.accounting_aging(date) to authenticated;
revoke all on function public.take_inventory_snapshot(date, text) from public, anon;
grant execute on function public.take_inventory_snapshot(date, text) to authenticated;
revoke all on function public.delete_inventory_snapshot(uuid) from public, anon;
grant execute on function public.delete_inventory_snapshot(uuid) to authenticated;
revoke all on function public.accounting_month(date) from public, anon;
grant execute on function public.accounting_month(date) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('156_accounting_stage2') on conflict do nothing;
