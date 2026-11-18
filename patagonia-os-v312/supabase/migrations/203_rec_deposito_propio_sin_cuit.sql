-- Remito Electrónico Cárnico: remito a un depósito propio (tipo de receptor EM) sin CUIT del receptor.
--
-- Prueba real contra ARCA producción (Della Finca, 2026-11-18, pedido armado para ser rechazado):
-- con tipoReceptor EM y cuitReceptor = CUIT del emisor, ARCA respondió
--   1312 "No se debe informar la CUIT del receptor".
-- create_rec_remito (migración 202) exigía y guardaba ese CUIT; ahora, para EM, no lo guarda
-- (ni la categoría del receptor). Para clientes (MI) no cambia nada. Solo se reemplaza esta función,
-- con la misma firma: los permisos (grant a authenticated) se mantienen.
-- La Edge Function arca-remito tampoco lo manda para EM (cubre borradores anteriores).

create or replace function public.create_rec_remito(p_client_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_settings record;
  v_fiscal record;
  v_point record;
  v_id uuid;
  v_id_req bigint;
  v_today date := public.today_ar();
  v_mov text := upper(coalesce(p_data->>'tipo_movimiento', ''));
  v_tipo_rec text := nullif(upper(coalesce(p_data->>'tipo_receptor', '')), '');
  v_cuit_rec text := nullif(regexp_replace(coalesce(p_data->>'cuit_receptor', ''), '\D', '', 'g'), '');
  v_cuit_tra text := nullif(regexp_replace(coalesce(p_data->>'cuit_transportista', ''), '\D', '', 'g'), '');
  v_cuit_con text := nullif(regexp_replace(coalesce(p_data->>'cuit_conductor', ''), '\D', '', 'g'), '');
  v_fecha date := nullif(p_data->>'fecha_inicio_viaje', '')::date;
  v_km numeric := nullif(p_data->>'distancia_km', '')::numeric;
  v_dominio text := nullif(upper(regexp_replace(coalesce(p_data->>'dominio_vehiculo', ''), '\s', '', 'g')), '');
  v_dom_dest integer := nullif(p_data->>'cod_dom_destino', '')::integer;
  v_cat_rec smallint := nullif(p_data->>'categoria_receptor', '')::smallint;
  v_item jsonb;
  v_orden integer := 0;
  v_code text;
  v_product uuid;
begin
  perform public.require_plan('full');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin', 'manager', 'production') then raise exception 'No tenés permiso para emitir remitos'; end if;
  if p_client_id is null then raise exception 'Falta el identificador del pedido'; end if;

  -- Doble clic / reintento: el mismo formulario devuelve el mismo remito.
  select id into v_id from public.rec_remitos where company_id = v_company_id and client_id = p_client_id;
  if v_id is not null then return v_id; end if;

  select * into v_settings from public.rec_settings where company_id = v_company_id;
  if v_settings is null or not v_settings.enabled then
    raise exception 'El remito electrónico cárnico no está conectado con ARCA: probá la conexión en Facturas';
  end if;
  select * into v_fiscal from public.company_fiscal_settings where company_id = v_company_id;
  if v_fiscal is null then raise exception 'Faltan los datos fiscales del negocio'; end if;

  select * into v_point from public.rec_points
  where company_id = v_company_id and point_of_emission = nullif(p_data->>'point_of_emission', '')::integer and active;
  if v_point is null then raise exception 'Elegí un punto de emisión activo'; end if;
  if v_point.branch_id is not null and not public.my_branch_allowed(v_point.branch_id) then
    raise exception 'No podés emitir desde ese local';
  end if;

  -- Reglas del manual de ARCA (2.5.2.4) que se pueden revisar acá. ARCA vuelve a validar todo.
  if v_mov not in ('ENV', 'REP', 'PLA') then raise exception 'Tipo de movimiento inválido'; end if;
  if v_settings.categoria_emisor is null then raise exception 'Falta la categoría del emisor (Facturas → Remito electrónico cárnico)'; end if;
  if v_mov = 'REP' then
    if v_tipo_rec is not null or v_cuit_rec is not null or v_dom_dest is not null or v_cat_rec is not null then
      raise exception 'En un reparto no se informa destinatario ni domicilio de destino';
    end if;
  else
    if v_tipo_rec not in ('MI', 'EM') then raise exception 'Elegí si va a otro depósito propio o a un cliente'; end if;
    if v_tipo_rec = 'EM' then
      -- Depósito propio: ARCA rechaza el CUIT y la categoría del receptor (error 1312, producción 2026-11-18).
      v_cuit_rec := null;
      v_cat_rec := null;
    elsif v_cuit_rec is null or not public.is_valid_cuit(v_cuit_rec) then
      raise exception 'El CUIT del destinatario no es válido';
    end if;
    if v_tipo_rec = 'MI' and v_cat_rec is null then raise exception 'Falta la categoría del destinatario'; end if;
    if v_mov = 'ENV' and v_dom_dest is null then raise exception 'Falta el domicilio de destino'; end if;
  end if;
  if v_fecha is null or v_fecha < v_today then raise exception 'La fecha de inicio del viaje no puede ser anterior a hoy'; end if;
  if v_km is null or v_km <= 0 or v_km > 99999 then raise exception 'Falta la distancia en km'; end if;
  if v_cuit_tra is null or not public.is_valid_cuit(v_cuit_tra) then raise exception 'El CUIT del transportista no es válido'; end if;
  if v_cuit_con is not null and not public.is_valid_cuit(v_cuit_con) then raise exception 'El CUIT/CUIL del conductor no es válido'; end if;
  if v_dominio is null then raise exception 'Falta la patente del vehículo'; end if;
  if jsonb_typeof(p_data->'items') <> 'array' or jsonb_array_length(p_data->'items') = 0 then raise exception 'Agregá al menos un producto'; end if;
  if jsonb_array_length(p_data->'items') > 9999 then raise exception 'Demasiados renglones'; end if;

  -- Número del pedido (idReq), único por punto de emisión: AAAAMMDD + 5 cifras, así no
  -- choca con otro sistema que haya numerado desde 1 en el mismo punto.
  perform pg_advisory_xact_lock(hashtext('rec_id_req:' || v_company_id::text || ':' || v_point.point_of_emission::text));
  select coalesce(max(id_req), 0) into v_id_req from public.rec_remitos
  where company_id = v_company_id and point_of_emission = v_point.point_of_emission
    and id_req >= to_char(v_today, 'YYYYMMDD')::bigint * 100000;
  v_id_req := greatest(v_id_req + 1, to_char(v_today, 'YYYYMMDD')::bigint * 100000 + 1);

  insert into public.rec_remitos (
    company_id, branch_id, client_id, point_of_emission, id_req, tipo_movimiento, categoria_emisor, cuit_emisor,
    tipo_receptor, categoria_receptor, cuit_receptor, receptor_name, cod_dom_destino, destino_desc,
    destination_branch_id, customer_id, branch_transfer_id, motivo,
    cuit_transportista, transportista_name, cuit_conductor, fecha_inicio_viaje, distancia_km, dominio_vehiculo, dominio_acoplado,
    issuer, notes, created_by
  ) values (
    v_company_id, v_point.branch_id, p_client_id, v_point.point_of_emission, v_id_req, v_mov, v_settings.categoria_emisor, v_fiscal.cuit,
    case when v_mov = 'REP' then null else v_tipo_rec end, v_cat_rec, v_cuit_rec,
    nullif(trim(coalesce(p_data->>'receptor_name', '')), ''), v_dom_dest, nullif(trim(coalesce(p_data->>'destino_desc', '')), ''),
    (select id from public.branches where id = nullif(p_data->>'destination_branch_id', '')::uuid and company_id = v_company_id),
    (select id from public.customers where id = nullif(p_data->>'customer_id', '')::uuid and company_id = v_company_id),
    (select id from public.branch_transfers where id = nullif(p_data->>'branch_transfer_id', '')::uuid and company_id = v_company_id),
    nullif(trim(coalesce(p_data->>'motivo', '')), ''),
    v_cuit_tra, nullif(trim(coalesce(p_data->>'transportista_name', '')), ''), v_cuit_con, v_fecha, round(v_km, 2), v_dominio,
    nullif(upper(regexp_replace(coalesce(p_data->>'dominio_acoplado', ''), '\s', '', 'g')), ''),
    jsonb_build_object('business_name', v_fiscal.business_name, 'cuit', v_fiscal.cuit, 'address', v_fiscal.address,
      'point_label', v_point.label, 'point_description', v_point.arca_description, 'categoria_emisor_desc', v_settings.categoria_emisor_desc),
    nullif(trim(coalesce(p_data->>'notes', '')), ''), v_user_id
  ) returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_data->'items') loop
    v_orden := v_orden + 1;
    v_code := trim(coalesce(v_item->>'cod_tipo_prod', ''));
    if v_code !~ '^[0-9]{1,2}\.[0-9]{1,3}$' then
      raise exception 'Renglón %: el código de mercadería de ARCA tiene la forma tabla.item (por ejemplo 6.24)', v_orden;
    end if;
    if coalesce((v_item->>'kilos')::numeric, 0) <= 0 and coalesce((v_item->>'unidades')::numeric, 0) <= 0 then
      raise exception 'Renglón %: indicá kilos o unidades', v_orden;
    end if;
    v_product := (select id from public.products where id = nullif(v_item->>'product_id', '')::uuid and company_id = v_company_id);
    insert into public.rec_remito_items (remito_id, company_id, orden, product_id, product_name, cod_tipo_prod, tropa, kilos, unidades)
    values (v_id, v_company_id, v_orden, v_product, nullif(trim(coalesce(v_item->>'product_name', '')), ''), v_code,
      nullif(v_item->>'tropa', '')::bigint, round(nullif(v_item->>'kilos', '')::numeric, 2), round(nullif(v_item->>'unidades', '')::numeric, 2));
    if v_product is not null then
      insert into public.rec_product_codes (company_id, product_id, cod_tipo_prod, updated_at)
      values (v_company_id, v_product, v_code, now())
      on conflict (company_id, product_id) do update set cod_tipo_prod = excluded.cod_tipo_prod, updated_at = now();
    end if;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_point.branch_id, v_user_id, 'rec.create', 'rec_remito', v_id::text,
    jsonb_build_object('point', v_point.point_of_emission, 'id_req', v_id_req, 'movimiento', v_mov, 'cuit_receptor', v_cuit_rec, 'items', v_orden));
  return v_id;
end;
$$;

insert into public.schema_migrations (version) values ('203_rec_deposito_propio_sin_cuit') on conflict do nothing;
