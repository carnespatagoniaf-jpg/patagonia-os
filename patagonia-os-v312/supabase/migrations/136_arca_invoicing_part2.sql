-- Factura electrónica ARCA, parte 2 (2026-10-19): el CAE lo pide la Edge
-- Function `arca-invoice` con el certificado de Patagonia OS (alias
-- patagoniaos, CUIT 27-18244890-2). Planes Estándar y Full, como la 121.
--
-- Lo nuevo:
-- 1. invoices: control para no duplicar números (pending_number = número que se
--    le pidió a ARCA y todavía no se confirmó; claimed_at = una caja lo está
--    pidiendo), fecha del comprobante (issued_on) y facturas de ventas en cuenta
--    corriente (customer_charge_id). Pedido del dueño: en Clientes casi todo sale
--    con remito, pero algunas ventas tienen que poder salir con factura.
-- 2. customers: CUIT/DNI y condición frente al IVA, para no volver a escribirlos
--    en la próxima factura del mismo cliente.
-- 3. arca_access_tickets: el ticket de acceso del WSAA (dura 12 h y ARCA no da
--    otro mientras esté vigente). Solo lo toca la Edge Function: RLS sin políticas.
-- 4. request_charge_invoice: pedir la factura de una venta en cuenta corriente.
-- 5. Notas de crédito: automática al anular una venta de Mostrador facturada
--    (trigger) y a mano desde Facturas (request_credit_note). Una venta en cuenta
--    corriente facturada no se puede corregir ni borrar hasta tener su nota de
--    crédito autorizada (trigger customer_charges_invoice_guard).

alter table public.invoices
  add column if not exists customer_charge_id uuid references public.customer_charges(id) on delete set null,
  add column if not exists pending_number bigint,
  add column if not exists claimed_at timestamptz,
  add column if not exists issued_on date;

create unique index if not exists invoices_one_per_charge
  on public.invoices (customer_charge_id) where kind = 'factura' and status <> 'rechazada';
create index if not exists invoices_related_idx on public.invoices (related_invoice_id) where related_invoice_id is not null;

alter table public.customers
  add column if not exists tax_id text,
  add column if not exists tax_condition text;
alter table public.customers drop constraint if exists customers_tax_condition_check;
alter table public.customers add constraint customers_tax_condition_check
  check (tax_condition is null or tax_condition in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento'));

create table if not exists public.arca_access_tickets (
  env text not null check (env in ('homo', 'prod')),
  service text not null,
  token text not null,
  sign text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (env, service)
);
alter table public.arca_access_tickets enable row level security;
revoke all on public.arca_access_tickets from anon, authenticated;

-- Arma documento, letra e IVA (mismas reglas que request_invoice de la 113).
create or replace function public.invoice_fields_for(
  p_settings public.company_fiscal_settings,
  p_total numeric,
  p_customer_tax_condition text,
  p_customer_doc text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_condition text := coalesce(p_customer_tax_condition, 'consumidor_final');
  v_doc text := regexp_replace(coalesce(p_customer_doc, ''), '\D', '', 'g');
  v_doc_type int;
  v_letter text;
  v_type int;
  v_rate numeric := 0;
  v_net numeric;
  v_vat numeric := 0;
begin
  if v_condition not in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento') then
    raise exception 'Condición del cliente inválida';
  end if;
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

  if p_settings.tax_condition = 'monotributo' then
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

  if v_doc_type = 99 and p_total >= 10000000 then
    raise exception 'Desde $10.000.000 hay que poner el DNI o CUIT del cliente';
  end if;

  if v_letter = 'C' then
    v_net := p_total;
  else
    v_rate := p_settings.default_vat_rate;
    v_net := round(p_total / (1 + v_rate / 100), 2);
    v_vat := p_total - v_net;
  end if;

  return jsonb_build_object('condition', v_condition, 'doc_type', v_doc_type, 'doc', v_doc, 'letter', v_letter,
                            'type', v_type, 'rate', v_rate, 'net', v_net, 'vat', v_vat);
end;
$$;
revoke all on function public.invoice_fields_for(public.company_fiscal_settings, numeric, text, text) from public, anon, authenticated;

-- Factura de una venta en cuenta corriente (Clientes). La venta sigue teniendo su remito.
create or replace function public.request_charge_invoice(
  p_charge_id uuid,
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
  v_charge public.customer_charges%rowtype;
  v_customer public.customers%rowtype;
  v_f jsonb;
  v_id uuid;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select * into v_settings from public.company_fiscal_settings where company_id = v_company_id;
  if v_settings.company_id is null or not v_settings.enabled then
    raise exception 'La factura electrónica no está activada en este negocio';
  end if;

  select * into v_charge from public.customer_charges where id = p_charge_id and company_id = v_company_id for update;
  if v_charge.id is null then
    raise exception 'Venta inválida';
  end if;
  if exists (select 1 from public.invoices where customer_charge_id = v_charge.id and kind = 'factura' and status <> 'rechazada') then
    raise exception 'Esta venta ya tiene factura';
  end if;
  select * into v_customer from public.customers where id = v_charge.customer_id;

  v_f := public.invoice_fields_for(v_settings, v_charge.amount, p_customer_tax_condition, p_customer_doc);

  insert into public.invoices (
    company_id, branch_id, customer_charge_id, kind, letter, voucher_type, point_of_sale, status,
    customer_doc_type, customer_doc_number, customer_name, customer_tax_condition,
    total, net, vat, vat_rate, created_by
  ) values (
    v_company_id, v_customer.branch_id, v_charge.id, 'factura', v_f->>'letter', (v_f->>'type')::int, v_settings.point_of_sale, 'pendiente',
    (v_f->>'doc_type')::int, v_f->>'doc', coalesce(nullif(trim(p_customer_name), ''), v_customer.name), v_f->>'condition',
    v_charge.amount, (v_f->>'net')::numeric, (v_f->>'vat')::numeric, (v_f->>'rate')::numeric, v_user_id
  )
  returning id into v_id;

  -- Se recuerda para la próxima factura de este cliente.
  update public.customers
  set tax_condition = v_f->>'condition',
      tax_id = case when (v_f->>'doc_type')::int = 99 then tax_id else v_f->>'doc' end
  where id = v_charge.customer_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_customer.branch_id, v_user_id, 'invoice.request', 'invoice', v_id::text,
          jsonb_build_object('charge_id', v_charge.id, 'letter', v_f->>'letter', 'total', v_charge.amount, 'doc_type', v_f->>'doc_type'));

  return jsonb_build_object('invoice_id', v_id, 'letter', v_f->>'letter', 'total', v_charge.amount,
                            'net', (v_f->>'net')::numeric, 'vat', (v_f->>'vat')::numeric);
end;
$$;
revoke all on function public.request_charge_invoice(uuid, text, text, text) from public, anon;
grant execute on function public.request_charge_invoice(uuid, text, text, text) to authenticated;

-- Deja pendiente la nota de crédito de una factura autorizada (interna: la usan
-- el trigger, request_credit_note y la Edge Function). Devuelve su id o null si ya había una.
create or replace function public.arca_queue_credit_note(p_invoice_id uuid, p_user_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices%rowtype;
  v_id uuid;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if v_inv.id is null or v_inv.kind <> 'factura' or v_inv.status <> 'autorizada' then
    return null;
  end if;
  if exists (select 1 from public.invoices where related_invoice_id = v_inv.id and kind = 'nota_credito' and status <> 'rechazada') then
    return null;
  end if;
  insert into public.invoices (
    company_id, branch_id, pos_sale_id, customer_charge_id, kind, letter, voucher_type, point_of_sale, status,
    customer_doc_type, customer_doc_number, customer_name, customer_tax_condition,
    total, net, vat, vat_rate, related_invoice_id, created_by
  ) values (
    v_inv.company_id, v_inv.branch_id, v_inv.pos_sale_id, v_inv.customer_charge_id, 'nota_credito', v_inv.letter,
    case v_inv.voucher_type when 1 then 3 when 6 then 8 else 13 end, v_inv.point_of_sale, 'pendiente',
    v_inv.customer_doc_type, v_inv.customer_doc_number, v_inv.customer_name, v_inv.customer_tax_condition,
    v_inv.total, v_inv.net, v_inv.vat, v_inv.vat_rate, v_inv.id, p_user_id
  )
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.arca_queue_credit_note(uuid, uuid) from public, anon, authenticated;
grant execute on function public.arca_queue_credit_note(uuid, uuid) to service_role;

-- Nota de crédito a mano (Facturas → "Anular con nota de crédito"): dueño o administrador.
create or replace function public.request_credit_note(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_inv public.invoices%rowtype;
  v_id uuid;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador anula facturas';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id and company_id = v_company_id;
  if v_inv.id is null or v_inv.kind <> 'factura' then
    raise exception 'Factura inválida';
  end if;
  if v_inv.status <> 'autorizada' then
    raise exception 'Solo se anula una factura ya autorizada por ARCA';
  end if;
  v_id := public.arca_queue_credit_note(v_inv.id, v_user_id);
  if v_id is null then
    raise exception 'Esta factura ya tiene su nota de crédito';
  end if;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_inv.branch_id, v_user_id, 'invoice.credit_note', 'invoice', v_id::text,
          jsonb_build_object('invoice_id', v_inv.id, 'total', v_inv.total));
  return v_id;
end;
$$;
revoke all on function public.request_credit_note(uuid) from public, anon;
grant execute on function public.request_credit_note(uuid) to authenticated;

-- Anular una venta de Mostrador facturada deja su nota de crédito pendiente
-- (la pantalla llama enseguida a la Edge Function para autorizarla).
create or replace function public.pos_sales_void_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
begin
  if old.voided_at is null and new.voided_at is not null then
    select id into v_invoice_id from public.invoices
    where pos_sale_id = new.id and kind = 'factura' and status = 'autorizada'
    limit 1;
    if v_invoice_id is not null then
      perform public.arca_queue_credit_note(v_invoice_id, new.voided_by);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.pos_sales_void_credit_note() from public, anon, authenticated;
drop trigger if exists pos_sales_void_credit_note on public.pos_sales;
create trigger pos_sales_void_credit_note
  after update of voided_at on public.pos_sales
  for each row execute function public.pos_sales_void_credit_note();

-- Una venta en cuenta corriente con factura viva no se toca: primero la nota de crédito.
create or replace function public.customer_charges_invoice_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.invoices f
    where f.customer_charge_id = old.id and f.kind = 'factura' and f.status in ('pendiente', 'autorizada')
      and not exists (
        select 1 from public.invoices nc
        where nc.related_invoice_id = f.id and nc.kind = 'nota_credito' and nc.status = 'autorizada'
      )
  ) then
    raise exception 'Esta venta tiene factura. Para cambiarla o borrarla, primero anulá la factura con nota de crédito en Facturas.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.customer_charges_invoice_guard() from public, anon, authenticated;
drop trigger if exists customer_charges_invoice_guard on public.customer_charges;
create trigger customer_charges_invoice_guard
  before update or delete on public.customer_charges
  for each row execute function public.customer_charges_invoice_guard();

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('136_arca_invoicing_part2') on conflict do nothing;
