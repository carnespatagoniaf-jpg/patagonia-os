-- Pruebas de la migración 202 (Remito Electrónico Cárnico: borradores, idReq, doble clic). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: plan Full con dos locales. B: otra empresa Full. C: plan Estándar (no tiene remito).
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000d2021', 'Frigo A', 9921, 'full'),
  ('00000000-0000-0000-0000-0000000d2031', 'Frigo B', 9922, 'full'),
  ('00000000-0000-0000-0000-0000000d2041', 'Estandar C', 9923, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d2022', '00000000-0000-0000-0000-0000000d2021', 'Planta'),
  ('00000000-0000-0000-0000-0000000d2023', '00000000-0000-0000-0000-0000000d2021', 'Centro'),
  ('00000000-0000-0000-0000-0000000d2032', '00000000-0000-0000-0000-0000000d2031', 'Única B'),
  ('00000000-0000-0000-0000-0000000d2042', '00000000-0000-0000-0000-0000000d2041', 'Única C');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d2025', 'duenio@a202'), ('00000000-0000-0000-0000-0000000d2026', 'cajera@a202'),
  ('00000000-0000-0000-0000-0000000d2027', 'contador@a202'), ('00000000-0000-0000-0000-0000000d2035', 'duenio@b202'),
  ('00000000-0000-0000-0000-0000000d2045', 'duenio@c202');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000d2025', '00000000-0000-0000-0000-0000000d2021', '00000000-0000-0000-0000-0000000d2022', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000d2026', '00000000-0000-0000-0000-0000000d2021', '00000000-0000-0000-0000-0000000d2023', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000d2027', '00000000-0000-0000-0000-0000000d2021', '00000000-0000-0000-0000-0000000d2022', 'Contador', 'accountant'),
  ('00000000-0000-0000-0000-0000000d2035', '00000000-0000-0000-0000-0000000d2031', '00000000-0000-0000-0000-0000000d2032', 'Dueño B', 'owner'),
  ('00000000-0000-0000-0000-0000000d2045', '00000000-0000-0000-0000-0000000d2041', '00000000-0000-0000-0000-0000000d2042', 'Dueño C', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000d202a', '00000000-0000-0000-0000-0000000d2021', '101', 'Cuadril', 'kg', 10000, 15000),
  ('00000000-0000-0000-0000-0000000d203a', '00000000-0000-0000-0000-0000000d2031', '1', 'Producto B', 'kg', 10000, 15000);
insert into company_fiscal_settings (company_id, cuit, business_name, tax_condition, point_of_sale, address, gross_income_number, activity_start) values
  ('00000000-0000-0000-0000-0000000d2021', '30719560381', 'Frigo A SA', 'responsable_inscripto', 4, 'Ruta 3 km 5', '901-1', date '2015-03-01');
-- La conexión la marca la Edge Function (service role); acá se simula.
insert into rec_settings (company_id, enabled) values ('00000000-0000-0000-0000-0000000d2021', true);

set local role authenticated;

-- Dueño A: configura categoría y punto 20 en la Planta.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2025', true);
select public.save_rec_settings(1::smallint, 'Categoría de prueba');
select public.save_rec_point(20, '00000000-0000-0000-0000-0000000d2022', 'Planta', true);

-- La web no puede escribir las tablas directo.
do $$
begin
  begin
    update public.rec_remitos set status = 'emitido';
    raise exception 'se pudo escribir rec_remitos directo';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Datos de un envío común a un cliente (mercado interno).
create temp table t202 as select jsonb_build_object(
  'point_of_emission', 20, 'tipo_movimiento', 'ENV', 'tipo_receptor', 'MI', 'categoria_receptor', 3,
  'cuit_receptor', '20-11111111-2', 'receptor_name', 'Cliente', 'cod_dom_destino', 0,
  'fecha_inicio_viaje', public.today_ar()::text, 'distancia_km', 12.5,
  'cuit_transportista', '30719560381', 'dominio_vehiculo', 'ab 123 cd',
  'items', jsonb_build_array(
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000d202a', 'product_name', 'Cuadril', 'cod_tipo_prod', '6.21', 'kilos', 50.456),
    jsonb_build_object('cod_tipo_prod', '1.1', 'tropa', 121, 'kilos', 110, 'unidades', 1)
  )) as d;
grant select on t202 to authenticated;

do $$
declare
  v1 uuid; v2 uuid; v3 uuid; r record; n int;
begin
  -- Doble clic: mismo client_id = mismo remito.
  v1 := public.create_rec_remito('00000000-0000-0000-0000-0000000d20f1', (select d from t202));
  v2 := public.create_rec_remito('00000000-0000-0000-0000-0000000d20f1', (select d from t202));
  if v1 <> v2 then raise exception 'doble clic creó dos remitos'; end if;
  select count(*) into n from public.rec_remitos where client_id = '00000000-0000-0000-0000-0000000d20f1';
  if n <> 1 then raise exception 'hay % remitos para un mismo pedido', n; end if;

  select * into r from public.rec_remitos where id = v1;
  if r.status <> 'pendiente' or r.cuit_emisor <> '30719560381' or r.cuit_receptor <> '20111111112' or r.dominio_vehiculo <> 'AB123CD' then
    raise exception 'datos del remito mal guardados: %', row_to_json(r);
  end if;
  if r.id_req <> to_char(public.today_ar(), 'YYYYMMDD')::bigint * 100000 + 1 then raise exception 'idReq inesperado: %', r.id_req; end if;
  if r.cod_dom_destino <> 0 then raise exception 'el domicilio fiscal (0) no se guardó'; end if;
  select count(*) into n from public.rec_remito_items where remito_id = v1;
  if n <> 2 then raise exception 'renglones: %', n; end if;
  if (select kilos from public.rec_remito_items where remito_id = v1 and orden = 1) <> 50.46 then raise exception 'kilos no redondeados a 2 decimales'; end if;
  if (select cod_tipo_prod from public.rec_product_codes where product_id = '00000000-0000-0000-0000-0000000d202a') <> '6.21' then
    raise exception 'no recordó el código de ARCA del producto';
  end if;

  -- Otro formulario: el idReq sigue en orden.
  v3 := public.create_rec_remito('00000000-0000-0000-0000-0000000d20f2', (select d from t202));
  if (select id_req from public.rec_remitos where id = v3) <> r.id_req + 1 then raise exception 'el segundo idReq no es el siguiente'; end if;

  -- Reglas del manual.
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d || jsonb_build_object('fecha_inicio_viaje', (public.today_ar() - 1)::text) from t202));
    raise exception 'aceptó una fecha de viaje pasada';
  exception when raise_exception then if sqlerrm not like '%anterior a hoy%' then raise; end if;
  end;
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d || '{"cuit_receptor":"20111111113"}'::jsonb from t202));
    raise exception 'aceptó un CUIT inválido';
  exception when raise_exception then if sqlerrm not like '%CUIT del destinatario%' then raise; end if;
  end;
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d || '{"tipo_movimiento":"REP"}'::jsonb from t202));
    raise exception 'aceptó un reparto con destinatario';
  exception when raise_exception then if sqlerrm not like '%reparto%' then raise; end if;
  end;
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d || '{"items":[{"cod_tipo_prod":"624","kilos":1}]}'::jsonb from t202));
    raise exception 'aceptó un código de mercadería mal formado';
  exception when raise_exception then if sqlerrm not like '%tabla.item%' then raise; end if;
  end;
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d || '{"point_of_emission":21}'::jsonb from t202));
    raise exception 'aceptó un punto de emisión no cargado';
  exception when raise_exception then if sqlerrm not like '%punto de emisión%' then raise; end if;
  end;

  -- Tirar: un borrador sin mandar sí; uno que ya pasó por ARCA no.
  perform public.discard_rec_remito(v3);
  if (select status from public.rec_remitos where id = v3) <> 'descartado' then raise exception 'no se descartó'; end if;
end $$;

-- Simula que ARCA ya lo tiene (lo hace la Edge Function con service role).
reset role;
update rec_remitos set status = 'generado', attempts = 1, sent_at = now() where client_id = '00000000-0000-0000-0000-0000000d20f1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2025', true);
do $$
begin
  begin
    perform public.discard_rec_remito((select id from public.rec_remitos where client_id = '00000000-0000-0000-0000-0000000d20f1'));
    raise exception 'se pudo tirar un remito que ARCA ya tiene';
  exception when raise_exception then if sqlerrm not like '%ya pasó por ARCA%' then raise; end if;
  end;
end $$;

-- Cajera: no emite remitos.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2026', true);
do $$
begin
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d from t202));
    raise exception 'una cajera pudo crear un remito';
  exception when raise_exception then if sqlerrm not like '%permiso%' then raise; end if;
  end;
end $$;

-- Contador: solo lectura.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2027', true);
do $$
begin
  begin
    perform public.save_rec_point(30, null, 'x', true);
    raise exception 'el contador pudo escribir';
  exception when others then if sqlerrm like 'el contador pudo%' then raise; end if;
  end;
end $$;

-- Empresa B: no ve los remitos de A y no puede emitir sin conexión.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2035', true);
do $$
begin
  if exists (select 1 from public.rec_remitos) or exists (select 1 from public.rec_remito_items) or exists (select 1 from public.rec_points) then
    raise exception 'la empresa B ve datos de A';
  end if;
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select d from t202));
    raise exception 'B emitió sin conexión con ARCA';
  exception when raise_exception then if sqlerrm not like '%no está conectado%' then raise; end if;
  end;
end $$;

-- Plan Estándar: no tiene el remito.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2045', true);
do $$
begin
  begin
    perform public.save_rec_point(20, null, null, true);
    raise exception 'Estándar pudo configurar el remito cárnico';
  exception when others then if sqlerrm like 'Estándar pudo%' then raise; end if;
  end;
end $$;

rollback;
