-- Remito R exacto según el Anexo V de la RG 1415 (2026-10-22, pedido del dueño:
-- "tiene que ser exacto"). Cambios sobre la 147:
--   - Destinatario: se pide su domicilio comercial (II, a/c/e/f). A consumidor
--     final solo lleva "A CONSUMIDOR FINAL", salvo que el remito sea de $5.000
--     o más: ahí van nombre, domicilio y CUIT/CUIL/DNI (II, d).
--   - Transportista (IV): cuando lleva un tercero, nombre, domicilio comercial
--     y CUIT de la empresa transportista. Con transporte propio no va.
--   - Condición del cliente: se elige al emitir (en Clientes casi siempre está
--     vacía; se completa recién al facturar) y se recuerda en su ficha.
--   - Emisor: solo responsables inscriptos o exentos (Anexo V, V.8 y RG 100:
--     un monotributista no puede ser autoimpresor).
--   - Emisor (I, a): número de Ingresos Brutos (o "condición de no
--     contribuyente") y fecha de inicio de actividades son obligatorios.
-- Los datos de la imprenta (I, a, 10 y 11) no van: el Anexo V, punto V.8, los
-- excluye para autoimpresores responsables inscriptos o exentos.
-- issue_remito cambia de firma: se borra la de la 147.

drop function if exists public.issue_remito(uuid, text, text, text, boolean);

create or replace function public.issue_remito(
  p_charge_id uuid,
  p_receiver_address text default null,
  p_receiver_doc text default null,
  p_receiver_condition text default null,
  p_delivery_address text default null,
  p_carrier_name text default null,
  p_carrier_cuit text default null,
  p_carrier_address text default null,
  p_notes text default null,
  p_show_values boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_charge record;
  v_fiscal record;
  v_cai record;
  v_next integer;
  v_items jsonb;
  v_id uuid;
  v_today date := public.today_ar();
  v_condition text;
  v_receiver_address text := nullif(trim(coalesce(p_receiver_address, '')), '');
  v_receiver_doc text := nullif(regexp_replace(coalesce(p_receiver_doc, ''), '\D', '', 'g'), '');
  v_carrier_name text := nullif(trim(coalesce(p_carrier_name, '')), '');
  v_carrier_cuit text := nullif(regexp_replace(coalesce(p_carrier_cuit, ''), '\D', '', 'g'), '');
  v_carrier_address text := nullif(trim(coalesce(p_carrier_address, '')), '');
  v_doc text;
begin
  perform public.require_plan('full');

  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select cc.id, cc.charge_date, cc.amount, cc.customer_id, c.name, c.tax_id, c.tax_condition, c.locality, c.province, c.branch_id, c.number as customer_number
  into v_charge
  from public.customer_charges cc
  join public.customers c on c.id = cc.customer_id
  where cc.id = p_charge_id and cc.company_id = v_company_id
  for update of cc;
  if not found then raise exception 'Venta inválida'; end if;

  select id into v_id from public.remitos where customer_charge_id = p_charge_id and status = 'emitido';
  if v_id is not null then return v_id; end if;

  select jsonb_agg(jsonb_build_object(
      'description', coalesce(p.name, i.description),
      'code', p.code,
      'unit', p.unit,
      'quantity', i.quantity,
      'unit_price', i.unit_price,
      'line_total', i.line_total
    ) order by i.created_at)
  into v_items
  from public.customer_charge_items i
  left join public.products p on p.id = i.product_id
  where i.charge_id = p_charge_id;
  if v_items is null then
    raise exception 'Esta venta no tiene detalle de productos: el remito necesita saber qué mercadería sale';
  end if;

  select * into v_fiscal from public.company_fiscal_settings where company_id = v_company_id;
  if v_fiscal is null
     or nullif(trim(coalesce(v_fiscal.cuit, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.business_name, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.address, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.gross_income_number, '')), '') is null
     or v_fiscal.activity_start is null then
    raise exception 'Faltan datos fiscales del negocio para el remito (CUIT, razón social, domicilio, Ingresos Brutos e inicio de actividades): cargalos en Facturas';
  end if;
  if v_fiscal.tax_condition = 'monotributo' then
    raise exception 'Un monotributista no puede ser autoimpresor: el Remito R desde el sistema es solo para responsables inscriptos o exentos';
  end if;

  -- Destinatario (Anexo V, II).
  v_condition := coalesce(nullif(p_receiver_condition, ''), nullif(v_charge.tax_condition, ''), 'consumidor_final');
  if v_condition not in ('consumidor_final', 'responsable_inscripto', 'monotributo', 'exento') then
    raise exception 'Condición frente al IVA del cliente inválida';
  end if;
  v_doc := coalesce(nullif(regexp_replace(coalesce(v_charge.tax_id, ''), '\D', '', 'g'), ''), v_receiver_doc);
  if v_condition <> 'consumidor_final' then
    if v_receiver_address is null then
      raise exception 'Falta el domicilio comercial del cliente';
    end if;
    if v_doc is null or length(v_doc) <> 11 then
      raise exception 'Falta el CUIT del cliente (11 números): cargalo en su ficha o al facturarle';
    end if;
  elsif v_charge.amount >= 5000 then
    if v_receiver_address is null or v_doc is null then
      raise exception 'A consumidor final, desde $5.000 el remito lleva domicilio y CUIT, CUIL o DNI del cliente';
    end if;
  end if;

  -- Transportista (Anexo V, IV): solo si lleva un tercero, y entonces completo.
  if v_carrier_name is not null or v_carrier_cuit is not null or v_carrier_address is not null then
    if v_carrier_name is null or v_carrier_address is null or v_carrier_cuit is null or length(v_carrier_cuit) <> 11 then
      raise exception 'Si lleva un transportista, van su nombre o razón social, domicilio comercial y CUIT (11 números)';
    end if;
  end if;

  -- El CAI vigente que vence primero y todavía tiene números. Se bloquea para que dos cajas no saquen el mismo número.
  for v_cai in
    select * from public.remito_cai
    where company_id = v_company_id and active and cai_due >= v_today
    order by cai_due, number_from
    for update
  loop
    select greatest(v_cai.number_from, coalesce(max(number), 0) + 1) into v_next
    from public.remitos where company_id = v_company_id and point_of_sale = v_cai.point_of_sale;
    if v_next <= v_cai.number_to then
      exit;
    end if;
    v_next := null;
  end loop;

  if v_next is null then
    raise exception 'No hay un CAI vigente con números libres: cargá uno nuevo en Facturas → Remito R';
  end if;

  insert into public.remitos (
    company_id, branch_id, cai_id, point_of_sale, number, cai, cai_due, issued_on,
    customer_id, customer_charge_id, issuer, receiver, items, show_values, total,
    delivery_address, carrier, notes, created_by
  ) values (
    v_company_id, v_charge.branch_id, v_cai.id, v_cai.point_of_sale, v_next, v_cai.cai, v_cai.cai_due, v_today,
    v_charge.customer_id, p_charge_id,
    jsonb_build_object(
      'business_name', v_fiscal.business_name, 'trade_name', v_fiscal.trade_name, 'cuit', v_fiscal.cuit,
      'tax_condition', v_fiscal.tax_condition, 'address', v_fiscal.address,
      'gross_income_number', v_fiscal.gross_income_number, 'activity_start', v_fiscal.activity_start),
    jsonb_build_object(
      'name', v_charge.name, 'number', v_charge.customer_number, 'tax_id', v_doc, 'tax_condition', v_condition,
      'address', v_receiver_address, 'locality', v_charge.locality, 'province', v_charge.province),
    v_items, coalesce(p_show_values, false), v_charge.amount,
    nullif(trim(coalesce(p_delivery_address, '')), ''),
    case when v_carrier_name is null then null
      else jsonb_build_object('name', v_carrier_name, 'cuit', v_carrier_cuit, 'address', v_carrier_address)::text end,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_user_id
  ) returning id into v_id;

  -- Se recuerda en la ficha del cliente para el próximo remito o factura.
  update public.customers
  set tax_condition = v_condition,
      tax_id = coalesce(nullif(tax_id, ''), case when length(v_doc) = 11 then v_doc end)
  where id = v_charge.customer_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_charge.branch_id, v_user_id, 'remito.issue', 'remito', v_id::text,
    jsonb_build_object('point_of_sale', v_cai.point_of_sale, 'number', v_next, 'customer_charge_id', p_charge_id));

  return v_id;
end;
$$;

revoke all on function public.issue_remito(uuid, text, text, text, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.issue_remito(uuid, text, text, text, text, text, text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('148_remito_r_anexo_v') on conflict do nothing;
