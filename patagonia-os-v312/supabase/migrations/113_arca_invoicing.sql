-- Factura electrónica ARCA, parte 1: datos fiscales y pedido de factura
-- (2026-10-08, pedido del dueño). Plan Full (regla: lo nuevo arranca en Full).
--
-- Modelo: cada carnicería le DELEGA en ARCA el servicio "Facturación
-- Electrónica" al CUIT del proveedor (Patagonia OS, 27-18244890-2), y el
-- servidor pide el CAE con el certificado de Patagonia indicando el CUIT de la
-- carnicería. Esta migración NO habla con ARCA: guarda lo necesario para que
-- la Edge Function (parte 2, cuando lleguen los certificados) autorice.
--
-- Decisiones del dueño:
-- - Se factura SOLO cuando el cliente pide factura (no todas las ventas).
-- - Monotributo emite Factura C. Responsable Inscripto emite A (a inscriptos
--   y monotributistas, con CUIT) o B (consumidor final / exento).
--
-- company_fiscal_settings: CUIT, razón social, condición, punto de venta (el
--   que la carnicería crea en ARCA como "RECE para aplicativo y web
--   services"), domicilio, IIBB, inicio de actividades y alícuota de IVA por
--   defecto (10,5 o 21; carne fresca suele ser 10,5: lo confirma el contador).
--   `enabled` solo lo prende la Edge Function cuando la prueba de conexión con
--   ARCA da bien: mientras esté en false, Mostrador no ofrece facturar.
-- invoices: cada pedido de factura (o nota de crédito) de una venta de
--   Mostrador. Nace "pendiente"; la Edge Function la pasa a "autorizada" (con
--   número, CAE y vencimiento) o "rechazada" (con el motivo de ARCA).
-- Lectura: toda la empresa (Mostrador necesita saber si está activa); sin
-- políticas de escritura: todo pasa por las funciones.

create or replace function public.is_valid_cuit(p_cuit text)
returns boolean
language sql
immutable
as $$
  select p_cuit ~ '^\d{11}$'
    and (
      case (11 - (
        substr(p_cuit, 1, 1)::int * 5 + substr(p_cuit, 2, 1)::int * 4 + substr(p_cuit, 3, 1)::int * 3 +
        substr(p_cuit, 4, 1)::int * 2 + substr(p_cuit, 5, 1)::int * 7 + substr(p_cuit, 6, 1)::int * 6 +
        substr(p_cuit, 7, 1)::int * 5 + substr(p_cuit, 8, 1)::int * 4 + substr(p_cuit, 9, 1)::int * 3 +
        substr(p_cuit, 10, 1)::int * 2) % 11)
        when 11 then 0
        when 10 then 9
        else 11 - (
          substr(p_cuit, 1, 1)::int * 5 + substr(p_cuit, 2, 1)::int * 4 + substr(p_cuit, 3, 1)::int * 3 +
          substr(p_cuit, 4, 1)::int * 2 + substr(p_cuit, 5, 1)::int * 7 + substr(p_cuit, 6, 1)::int * 6 +
          substr(p_cuit, 7, 1)::int * 5 + substr(p_cuit, 8, 1)::int * 4 + substr(p_cuit, 9, 1)::int * 3 +
          substr(p_cuit, 10, 1)::int * 2) % 11
      end
    ) = substr(p_cuit, 11, 1)::int;
$$;

create table if not exists public.company_fiscal_settings (
  company_id uuid primary key references public.companies(id),
  cuit text not null check (public.is_valid_cuit(cuit)),
  business_name text not null check (length(trim(business_name)) > 0),
  tax_condition text not null check (tax_condition in ('monotributo', 'responsable_inscripto')),
  point_of_sale int not null check (point_of_sale between 1 and 99998),
  address text,
  gross_income_number text,
  activity_start date,
  default_vat_rate numeric(5,2) not null default 10.5 check (default_vat_rate in (0, 10.5, 21, 27)),
  enabled boolean not null default false,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_message text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid references public.branches(id),
  pos_sale_id uuid references public.pos_sales(id),
  kind text not null default 'factura' check (kind in ('factura', 'nota_credito')),
  letter text not null check (letter in ('A', 'B', 'C')),
  -- Códigos de ARCA: 1 Factura A, 6 Factura B, 11 Factura C, 3/8/13 Notas de crédito A/B/C.
  voucher_type int not null check (voucher_type in (1, 3, 6, 8, 11, 13)),
  point_of_sale int not null,
  number bigint,
  status text not null default 'pendiente' check (status in ('pendiente', 'autorizada', 'rechazada')),
  cae text,
  cae_due date,
  -- 80 CUIT, 96 DNI, 99 sin identificar (consumidor final).
  customer_doc_type int not null check (customer_doc_type in (80, 96, 99)),
  customer_doc_number text not null default '0',
  customer_name text,
  customer_tax_condition text not null check (customer_tax_condition in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento')),
  total numeric(14,2) not null check (total > 0),
  net numeric(14,2) not null,
  vat numeric(14,2) not null default 0,
  vat_rate numeric(5,2) not null default 0,
  error_message text,
  related_invoice_id uuid references public.invoices(id),
  attempts int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  authorized_at timestamptz
);

create unique index if not exists invoices_number_unique
  on public.invoices (company_id, voucher_type, point_of_sale, number) where number is not null;
-- Una sola factura viva por venta (si ARCA la rechazó, se puede volver a pedir).
create unique index if not exists invoices_one_per_sale
  on public.invoices (pos_sale_id) where kind = 'factura' and status <> 'rechazada';
create index if not exists invoices_company_created_idx on public.invoices (company_id, created_at desc);
create index if not exists invoices_pending_idx on public.invoices (status) where status = 'pendiente';

alter table public.company_fiscal_settings enable row level security;
alter table public.invoices enable row level security;

drop policy if exists fiscal_settings_company_read on public.company_fiscal_settings;
create policy fiscal_settings_company_read on public.company_fiscal_settings
  for select using (company_id = public.current_company_id());
drop policy if exists plan_full on public.company_fiscal_settings;
create policy plan_full on public.company_fiscal_settings as restrictive
  for all using (public.company_plan_allows('full'));

drop policy if exists invoices_company_read on public.invoices;
create policy invoices_company_read on public.invoices
  for select using (company_id = public.current_company_id());
drop policy if exists plan_full on public.invoices;
create policy plan_full on public.invoices as restrictive
  for all using (public.company_plan_allows('full'));

grant select on public.company_fiscal_settings to authenticated;
grant select on public.invoices to authenticated;

-- Guardar los datos fiscales (dueño o administrador). Cambiar CUIT, condición o
-- punto de venta apaga `enabled`: hay que volver a probar la conexión con ARCA.
create or replace function public.save_fiscal_settings(
  p_cuit text,
  p_business_name text,
  p_tax_condition text,
  p_point_of_sale int,
  p_address text,
  p_gross_income_number text,
  p_activity_start date,
  p_default_vat_rate numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_cuit text := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
  v_old public.company_fiscal_settings%rowtype;
begin
  perform public.require_plan('full');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador cambia los datos fiscales';
  end if;

  if not public.is_valid_cuit(v_cuit) then
    raise exception 'El CUIT no es válido (revisá los 11 números)';
  end if;
  if p_business_name is null or length(trim(p_business_name)) = 0 then
    raise exception 'Falta la razón social';
  end if;
  if p_tax_condition not in ('monotributo', 'responsable_inscripto') then
    raise exception 'Condición frente al IVA inválida';
  end if;
  if p_point_of_sale is null or p_point_of_sale < 1 or p_point_of_sale > 99998 then
    raise exception 'El punto de venta tiene que ser un número entre 1 y 99998';
  end if;
  if coalesce(p_default_vat_rate, 10.5) not in (0, 10.5, 21, 27) then
    raise exception 'Alícuota de IVA inválida';
  end if;

  select * into v_old from public.company_fiscal_settings where company_id = v_company_id for update;

  insert into public.company_fiscal_settings (
    company_id, cuit, business_name, tax_condition, point_of_sale, address, gross_income_number,
    activity_start, default_vat_rate, enabled, updated_by, updated_at
  ) values (
    v_company_id, v_cuit, trim(p_business_name), p_tax_condition, p_point_of_sale, nullif(trim(p_address), ''),
    nullif(trim(p_gross_income_number), ''), p_activity_start, coalesce(p_default_vat_rate, 10.5), false, v_user_id, now()
  )
  on conflict (company_id) do update set
    cuit = excluded.cuit,
    business_name = excluded.business_name,
    tax_condition = excluded.tax_condition,
    point_of_sale = excluded.point_of_sale,
    address = excluded.address,
    gross_income_number = excluded.gross_income_number,
    activity_start = excluded.activity_start,
    default_vat_rate = excluded.default_vat_rate,
    enabled = case
      when v_old.cuit is distinct from excluded.cuit
        or v_old.tax_condition is distinct from excluded.tax_condition
        or v_old.point_of_sale is distinct from excluded.point_of_sale
      then false
      else public.company_fiscal_settings.enabled
    end,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'fiscal.settings', 'company', v_company_id::text,
          jsonb_build_object('cuit', v_cuit, 'tax_condition', p_tax_condition, 'point_of_sale', p_point_of_sale, 'default_vat_rate', p_default_vat_rate));
end;
$$;

-- Pedir la factura de una venta de Mostrador (la cajera, cuando el cliente la pide).
-- Arma tipo (A/B/C), documento e IVA y la deja "pendiente" para la Edge Function.
create or replace function public.request_invoice(
  p_sale_id uuid,
  p_customer_tax_condition text,
  p_customer_doc text,
  p_customer_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_settings public.company_fiscal_settings%rowtype;
  v_sale public.pos_sales%rowtype;
  v_condition text := coalesce(p_customer_tax_condition, 'consumidor_final');
  v_doc text := regexp_replace(coalesce(p_customer_doc, ''), '\D', '', 'g');
  v_doc_type int;
  v_letter text;
  v_type int;
  v_rate numeric := 0;
  v_net numeric;
  v_vat numeric := 0;
  v_id uuid;
begin
  perform public.require_plan('full');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select * into v_settings from public.company_fiscal_settings where company_id = v_company_id;
  if v_settings.company_id is null or not v_settings.enabled then
    raise exception 'La factura electrónica no está activada en este negocio';
  end if;

  select * into v_sale from public.pos_sales where id = p_sale_id and company_id = v_company_id for update;
  if v_sale.id is null then
    raise exception 'Venta inválida';
  end if;
  if v_sale.voided_at is not null then
    raise exception 'La venta está anulada';
  end if;
  if exists (select 1 from public.invoices where pos_sale_id = v_sale.id and kind = 'factura' and status <> 'rechazada') then
    raise exception 'Esta venta ya tiene factura';
  end if;

  if v_condition not in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento') then
    raise exception 'Condición del cliente inválida';
  end if;

  -- Documento: CUIT (11), DNI (7 u 8) o sin identificar.
  if v_doc = '' then
    v_doc_type := 99;
    v_doc := '0';
  elsif length(v_doc) = 11 then
    if not public.is_valid_cuit(v_doc) then
      raise exception 'El CUIT del cliente no es válido';
    end if;
    v_doc_type := 80;
  elsif length(v_doc) between 7 and 8 then
    v_doc_type := 96;
  else
    raise exception 'El documento del cliente tiene que ser un CUIT (11 números) o un DNI (7 u 8)';
  end if;

  if v_settings.tax_condition = 'monotributo' then
    v_letter := 'C';
    v_type := 11;
  elsif v_condition in ('responsable_inscripto', 'monotributo') then
    v_letter := 'A';
    v_type := 1;
    if v_doc_type <> 80 then
      raise exception 'Para Factura A hace falta el CUIT del cliente';
    end if;
  else
    v_letter := 'B';
    v_type := 6;
  end if;

  -- Consumidor final desde $10.000.000: hay que identificarlo (RG 5700/2025).
  if v_doc_type = 99 and v_sale.total >= 10000000 then
    raise exception 'Desde $10.000.000 hay que poner el DNI o CUIT del cliente';
  end if;

  if v_letter = 'C' then
    v_net := v_sale.total;
  else
    v_rate := v_settings.default_vat_rate;
    v_net := round(v_sale.total / (1 + v_rate / 100), 2);
    v_vat := v_sale.total - v_net;
  end if;

  insert into public.invoices (
    company_id, branch_id, pos_sale_id, kind, letter, voucher_type, point_of_sale, status,
    customer_doc_type, customer_doc_number, customer_name, customer_tax_condition,
    total, net, vat, vat_rate, created_by
  ) values (
    v_company_id, v_sale.branch_id, v_sale.id, 'factura', v_letter, v_type, v_settings.point_of_sale, 'pendiente',
    v_doc_type, v_doc, nullif(trim(p_customer_name), ''), v_condition,
    v_sale.total, v_net, v_vat, v_rate, v_user_id
  )
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_sale.branch_id, v_user_id, 'invoice.request', 'invoice', v_id::text,
          jsonb_build_object('sale_id', v_sale.id, 'letter', v_letter, 'total', v_sale.total, 'doc_type', v_doc_type));

  return jsonb_build_object('invoice_id', v_id, 'letter', v_letter, 'total', v_sale.total, 'net', v_net, 'vat', v_vat);
end;
$$;

revoke all on function public.save_fiscal_settings(text, text, text, int, text, text, date, numeric) from public, anon;
grant execute on function public.save_fiscal_settings(text, text, text, int, text, text, date, numeric) to authenticated;
revoke all on function public.request_invoice(uuid, text, text, text) from public, anon;
grant execute on function public.request_invoice(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('113_arca_invoicing') on conflict do nothing;
