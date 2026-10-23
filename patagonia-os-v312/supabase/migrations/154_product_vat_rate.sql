-- IVA por producto (2026-10-23, pedido del dueño para un cliente Responsable
-- Inscripto que vende con 10,5% (carne, verdura, pan) y 21% (fiambres, quesos)).
--   - products.vat_rate: 0 / 10,5 / 21 / 27, o null = usa el IVA general de
--     Facturas (company_fiscal_settings.default_vat_rate). Nada cambia para
--     quien no lo carga.
--   - set_products_vat_rate: lo cambia a uno o a muchos productos (por id o por
--     código, para Importar y para "toda la categoría").
--   - Factura A/B: el IVA se separa por alícuota según los productos de la venta
--     (invoices.vat_breakdown = [{rate, net, vat}], un AlicIva por alícuota en
--     ARCA). net / vat / vat_rate siguen guardando el total y la alícuota
--     principal, así lo viejo sigue funcionando. Factura C no cambia.
-- Los cuerpos de request_invoice / request_charge_invoice / invoice_fields_for
-- / arca_queue_credit_note son los de producción, con el cálculo nuevo.

alter table public.products
  add column if not exists vat_rate numeric(5,2) check (vat_rate in (0, 10.5, 21, 27));

alter table public.invoices
  add column if not exists vat_breakdown jsonb;

comment on column public.products.vat_rate is 'IVA del producto (0/10,5/21/27). Null = el IVA general de Facturas.';
comment on column public.invoices.vat_breakdown is 'Factura A/B: [{rate, net, vat}] por alícuota. Null = una sola alícuota (vat_rate).';

-- Cambia el IVA de varios productos de la empresa (por id o por código).
create or replace function public.set_products_vat_rate(
  p_product_ids uuid[] default null,
  p_codes text[] default null,
  p_rate numeric default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_count integer;
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

  if p_rate is not null and p_rate not in (0, 10.5, 21, 27) then
    raise exception 'El IVA tiene que ser 0, 10,5, 21 o 27';
  end if;

  update public.products
  set vat_rate = p_rate
  where company_id = v_company_id
    and (id = any(coalesce(p_product_ids, '{}')) or code = any(coalesce(p_codes, '{}')))
    and vat_rate is distinct from p_rate;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_user_id, 'product.vat_rate', 'product', null,
            jsonb_build_object('rate', p_rate, 'count', v_count));
  end if;

  return v_count;
end;
$$;

-- IVA separado por alícuota. p_lines = [{rate, amount}] (importes con IVA de
-- cada renglón). Se reparte el total real (con descuentos y recargos) en
-- proporción a los renglones; el redondeo va a la alícuota más grande.
-- Sin renglones: todo con p_default_rate.
create or replace function public.invoice_vat_breakdown(p_total numeric, p_default_rate numeric, p_lines jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sum numeric;
  v_groups jsonb := '[]'::jsonb;
  v_rec record;
  v_assigned numeric := 0;
  v_gross numeric;
  v_net numeric;
  v_count integer;
  v_i integer := 0;
  v_net_total numeric := 0;
  v_vat_total numeric := 0;
  v_main_rate numeric;
begin
  select coalesce(sum((l->>'amount')::numeric), 0), count(distinct coalesce((l->>'rate')::numeric, p_default_rate))
  into v_sum, v_count
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
  where coalesce((l->>'amount')::numeric, 0) > 0;

  for v_rec in
    select rate, gross from (
      select coalesce((l->>'rate')::numeric, p_default_rate) as rate, sum((l->>'amount')::numeric) as gross
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
      where coalesce((l->>'amount')::numeric, 0) > 0
      group by 1
    ) g
    where v_sum > 0
    -- La más grande al final: se lleva el redondeo.
    order by gross asc, rate asc
  loop
    v_i := v_i + 1;
    if v_i = v_count then
      v_gross := p_total - v_assigned;
      v_main_rate := v_rec.rate;
    else
      v_gross := round(p_total * v_rec.gross / v_sum, 2);
      v_assigned := v_assigned + v_gross;
    end if;
    v_net := round(v_gross / (1 + v_rec.rate / 100), 2);
    v_net_total := v_net_total + v_net;
    v_vat_total := v_vat_total + (v_gross - v_net);
    v_groups := v_groups || jsonb_build_array(jsonb_build_object('rate', v_rec.rate, 'net', v_net, 'vat', v_gross - v_net));
  end loop;

  if jsonb_array_length(v_groups) = 0 then
    v_main_rate := p_default_rate;
    v_net_total := round(p_total / (1 + p_default_rate / 100), 2);
    v_vat_total := p_total - v_net_total;
    v_groups := jsonb_build_array(jsonb_build_object('rate', p_default_rate, 'net', v_net_total, 'vat', v_vat_total));
  end if;

  return jsonb_build_object('rate', v_main_rate, 'net', v_net_total, 'vat', v_vat_total, 'breakdown', v_groups);
end;
$$;

-- Igual que antes (documento, letra), más p_lines para separar el IVA.
drop function if exists public.invoice_fields_for(public.company_fiscal_settings, numeric, text, text);

create or replace function public.invoice_fields_for(
  p_settings public.company_fiscal_settings,
  p_total numeric,
  p_customer_tax_condition text,
  p_customer_doc text,
  p_lines jsonb default null
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
  v_breakdown jsonb := null;
  v_vat_info jsonb;
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
    v_vat_info := public.invoice_vat_breakdown(p_total, p_settings.default_vat_rate, p_lines);
    v_rate := (v_vat_info->>'rate')::numeric;
    v_net := (v_vat_info->>'net')::numeric;
    v_vat := (v_vat_info->>'vat')::numeric;
    v_breakdown := v_vat_info->'breakdown';
  end if;

  return jsonb_build_object('condition', v_condition, 'doc_type', v_doc_type, 'doc', v_doc, 'letter', v_letter,
                            'type', v_type, 'rate', v_rate, 'net', v_net, 'vat', v_vat, 'breakdown', v_breakdown);
end;
$$;

create or replace function public.request_charge_invoice(p_charge_id uuid, p_customer_tax_condition text, p_customer_doc text, p_customer_name text)
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
  v_lines jsonb;
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

  select jsonb_agg(jsonb_build_object('rate', p.vat_rate, 'amount', i.line_total))
  into v_lines
  from public.customer_charge_items i
  left join public.products p on p.id = i.product_id and p.company_id = v_company_id
  where i.charge_id = v_charge.id;

  v_f := public.invoice_fields_for(v_settings, v_charge.amount, p_customer_tax_condition, p_customer_doc, v_lines);

  insert into public.invoices (
    company_id, branch_id, customer_charge_id, kind, letter, voucher_type, point_of_sale, status,
    customer_doc_type, customer_doc_number, customer_name, customer_tax_condition,
    total, net, vat, vat_rate, vat_breakdown, created_by
  ) values (
    v_company_id, v_customer.branch_id, v_charge.id, 'factura', v_f->>'letter', (v_f->>'type')::int, v_settings.point_of_sale, 'pendiente',
    (v_f->>'doc_type')::int, v_f->>'doc', coalesce(nullif(trim(p_customer_name), ''), v_customer.name), v_f->>'condition',
    v_charge.amount, (v_f->>'net')::numeric, (v_f->>'vat')::numeric, (v_f->>'rate')::numeric, nullif(v_f->'breakdown', 'null'::jsonb), v_user_id
  )
  returning id into v_id;

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

-- Mostrador: ahora usa invoice_fields_for (mismas reglas que tenía adentro).
create or replace function public.request_invoice(p_sale_id uuid, p_customer_tax_condition text, p_customer_doc text, p_customer_name text)
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
  v_lines jsonb;
  v_f jsonb;
  v_id uuid;
begin
  perform public.require_plan('estandar');
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

  select jsonb_agg(jsonb_build_object('rate', p.vat_rate, 'amount', i.line_total))
  into v_lines
  from public.pos_sale_items i
  left join public.products p on p.id = i.product_id and p.company_id = v_company_id
  where i.sale_id = v_sale.id;

  v_f := public.invoice_fields_for(v_settings, v_sale.total, p_customer_tax_condition, p_customer_doc, v_lines);

  insert into public.invoices (
    company_id, branch_id, pos_sale_id, kind, letter, voucher_type, point_of_sale, status,
    customer_doc_type, customer_doc_number, customer_name, customer_tax_condition,
    total, net, vat, vat_rate, vat_breakdown, created_by
  ) values (
    v_company_id, v_sale.branch_id, v_sale.id, 'factura', v_f->>'letter', (v_f->>'type')::int, v_settings.point_of_sale, 'pendiente',
    (v_f->>'doc_type')::int, v_f->>'doc', nullif(trim(p_customer_name), ''), v_f->>'condition',
    v_sale.total, (v_f->>'net')::numeric, (v_f->>'vat')::numeric, (v_f->>'rate')::numeric, nullif(v_f->'breakdown', 'null'::jsonb), v_user_id
  )
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_sale.branch_id, v_user_id, 'invoice.request', 'invoice', v_id::text,
          jsonb_build_object('sale_id', v_sale.id, 'letter', v_f->>'letter', 'total', v_sale.total, 'doc_type', v_f->>'doc_type'));

  return jsonb_build_object('invoice_id', v_id, 'letter', v_f->>'letter', 'total', v_sale.total,
                            'net', (v_f->>'net')::numeric, 'vat', (v_f->>'vat')::numeric);
end;
$$;

-- La nota de crédito copia el IVA separado de la factura que anula.
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
    total, net, vat, vat_rate, vat_breakdown, related_invoice_id, created_by
  ) values (
    v_inv.company_id, v_inv.branch_id, v_inv.pos_sale_id, v_inv.customer_charge_id, 'nota_credito', v_inv.letter,
    case v_inv.voucher_type when 1 then 3 when 6 then 8 else 13 end, v_inv.point_of_sale, 'pendiente',
    v_inv.customer_doc_type, v_inv.customer_doc_number, v_inv.customer_name, v_inv.customer_tax_condition,
    v_inv.total, v_inv.net, v_inv.vat, v_inv.vat_rate, v_inv.vat_breakdown, v_inv.id, p_user_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.set_products_vat_rate(uuid[], text[], numeric) from public, anon;
grant execute on function public.set_products_vat_rate(uuid[], text[], numeric) to authenticated;
revoke all on function public.invoice_vat_breakdown(numeric, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.invoice_fields_for(public.company_fiscal_settings, numeric, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.request_charge_invoice(uuid, text, text, text) from public, anon;
grant execute on function public.request_charge_invoice(uuid, text, text, text) to authenticated;
revoke all on function public.request_invoice(uuid, text, text, text) from public, anon;
grant execute on function public.request_invoice(uuid, text, text, text) to authenticated;
revoke all on function public.arca_queue_credit_note(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('154_product_vat_rate') on conflict do nothing;
