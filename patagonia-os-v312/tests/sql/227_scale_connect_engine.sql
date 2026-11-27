-- Pruebas de la migración 227 (Scale Connect de punta a punta: balanza ↔ PC y motor contra la nube). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: Centro y Norte. B: otra empresa.
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000f2001', 'Carnicería A', 9931, 'estandar'),
  ('00000000-0000-0000-0000-0000000f2011', 'Carnicería B', 9932, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f2002', '00000000-0000-0000-0000-0000000f2001', 'Centro'),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000f2001', 'Norte'),
  ('00000000-0000-0000-0000-0000000f2012', '00000000-0000-0000-0000-0000000f2011', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f2005', 'duenio@a'), ('00000000-0000-0000-0000-0000000f2006', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000f2008', 'lectura@a'), ('00000000-0000-0000-0000-0000000f2015', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f2005', '00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000f2006', '00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000f2008', '00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'Solo lectura', 'readonly'),
  ('00000000-0000-0000-0000-0000000f2015', '00000000-0000-0000-0000-0000000f2011', '00000000-0000-0000-0000-0000000f2012', 'Dueño B', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000f200a', '00000000-0000-0000-0000-0000000f2001', '1', 'Nalga', 'kg', 10000, 18000);
insert into scale_profiles (company_id, branch_id, scale_key, brand, name, family) values
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'kretz-1', 'kretz', 'Report mostrador', 'kretz'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'systel-1', 'systel', 'Cuora caja', 'systel'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2003', 'kretz-norte', 'kretz', 'Report Norte', 'kretz'),
  ('00000000-0000-0000-0000-0000000f2011', '00000000-0000-0000-0000-0000000f2012', 'kretz-1', 'kretz', 'Report de B', 'kretz');
-- Dos PC de A (Centro y Norte) y una de B, ya vinculadas (la 226 prueba el canje).
insert into scale_connectors (id, company_id, branch_id, name, secret_hash, version) values
  ('00000000-0000-0000-0000-0000000f20c1', '00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', 'Caja 1', encode(sha256(convert_to('s1', 'UTF8')), 'hex'), '0.2.0'),
  ('00000000-0000-0000-0000-0000000f20c2', '00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2003', 'PC Norte', encode(sha256(convert_to('s2', 'UTF8')), 'hex'), '0.2.0'),
  ('00000000-0000-0000-0000-0000000f20cb', '00000000-0000-0000-0000-0000000f2011', '00000000-0000-0000-0000-0000000f2012', 'Caja B', encode(sha256(convert_to('sb', 'UTF8')), 'hex'), '0.2.0');

create function pg_temp.must_fail(p_sql text, p_label text, p_code text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_code is not null and sqlstate <> p_code then
      raise exception 'Falló con % y se esperaba % (%): %', sqlstate, p_code, p_label, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
create function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.must_fail(text, text, text) to authenticated, service_role;
grant execute on function pg_temp.h(text) to authenticated, service_role;

-- 0. Permisos.
do $$
begin
  if has_function_privilege('authenticated', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'authenticated usa el motor del conector'; end if;
  if has_function_privilege('anon', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'anon usa el motor'; end if;
  if not has_function_privilege('service_role', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'service_role sin motor'; end if;
  if has_function_privilege('authenticated', 'public.scale_connect_clean_device(jsonb)', 'execute') then raise exception 'authenticated limpia huellas'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_heartbeat(uuid, text, text, jsonb)', 'execute') then raise exception 'authenticated late'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_config(uuid, text)', 'execute') then raise exception 'authenticated lee config'; end if;
  if not has_function_privilege('authenticated', 'public.bind_scale_to_connector(uuid, text, uuid, jsonb)', 'execute') then raise exception 'web sin vincular'; end if;
  if has_function_privilege('anon', 'public.bind_scale_to_connector(uuid, text, uuid, jsonb)', 'execute') then raise exception 'anon vincula'; end if;
  if has_function_privilege('anon', 'public.scale_connect_status(uuid)', 'execute') then raise exception 'anon ve el estado'; end if;
  if not exists (select 1 from public.schema_migrations where version = '227_scale_connect_engine') then raise exception 'falta schema_migrations'; end if;
end $$;

-- 1. Latido con huella física: se guarda limpia (sin campos de más, cada uno acotado).
set local role service_role;
do $$
declare r jsonb; s jsonb;
begin
  r := public.scale_connector_heartbeat('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), '0.3.0',
    '[{"key":"dev:usb-abc","name":"Kretz Report LT","online":true,"family":"kretz","model":"kretz-report-lt","label":"Kretz Report LT",
       "identity":{"letter":"C","equipment":"01"},
       "device":{"id":"usb-abc","kind":"serial","fingerprint":"serial:A12345","source":"serial","path":"COM3","chip":"FTDI FT232R","secreto":"no","port":"x"}},
      {"key":"dev:net-1","device":{"kind":"tcp"}},
      {"key":"dev:raro","family":"otra","identity":"texto"}]');
  if not (r ->> 'ok')::boolean then raise exception 'latido: %', r; end if;
  s := (select seen_scales from scale_connectors where id = '00000000-0000-0000-0000-0000000f20c1');
  if jsonb_array_length(s) <> 3 then raise exception 'balanzas vistas: %', s; end if;
  if s -> 0 -> 'device' ->> 'fingerprint' <> 'serial:A12345' or s -> 0 -> 'device' ->> 'path' <> 'COM3' or s -> 0 ->> 'family' <> 'kretz'
     or s -> 0 -> 'identity' ->> 'letter' <> 'C' then raise exception 'huella: %', s -> 0; end if;
  if (s -> 0 -> 'device') ? 'secreto' or (s -> 0 -> 'device') ? 'port' then raise exception 'campos de más: %', s -> 0; end if;
  if (s -> 1) ? 'device' then raise exception 'huella sin id: %', s -> 1; end if;
  if (s -> 2) ? 'family' or (s -> 2) ? 'identity' then raise exception 'marca o identidad inválidas: %', s -> 2; end if;
  perform public.scale_connector_heartbeat('00000000-0000-0000-0000-0000000f20c2', pg_temp.h('s2'), '0.3.0', '[]');
end $$;

-- 2. Vincular balanza ↔ PC: dueño o administrador, misma sucursal, puerto obligatorio.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2006', true);
select pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'kretz-1', '00000000-0000-0000-0000-0000000f20c1', '{"id":"usb-abc"}')$q$, 'cajera vincula');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2005', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'kretz-1', '00000000-0000-0000-0000-0000000f20c2', '{"id":"usb-abc"}')$q$, 'PC de otra sucursal');
  perform pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'kretz-1', '00000000-0000-0000-0000-0000000f20cb', '{"id":"usb-abc"}')$q$, 'PC de otra empresa');
  perform pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'kretz-1', '00000000-0000-0000-0000-0000000f20c1', '{"kind":"serial"}')$q$, 'sin puerto');
  perform pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'no-existe', '00000000-0000-0000-0000-0000000f20c1', '{"id":"usb-abc"}')$q$, 'balanza inexistente');
  perform pg_temp.must_fail($q$select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2012', 'kretz-1', '00000000-0000-0000-0000-0000000f20c1', '{"id":"usb-abc"}')$q$, 'balanza de B');

  perform public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'systel-1', '00000000-0000-0000-0000-0000000f20c1', '{"id":"usb-abc","kind":"serial","path":"COM3"}');
  -- El mismo puerto pasa a otra balanza: la primera queda sin PC.
  perform public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'kretz-1', '00000000-0000-0000-0000-0000000f20c1', '{"id":"usb-abc","kind":"serial","path":"COM3"}');
  if (select connector_id from scale_profiles where scale_key = 'systel-1') is not null then raise exception 'un puerto quedó en dos balanzas'; end if;
  if (select connector_device ->> 'path' from scale_profiles where scale_key = 'kretz-1' and company_id = '00000000-0000-0000-0000-0000000f2001') <> 'COM3' then raise exception 'no se vinculó'; end if;
  if (select count(*) from audit_log where action = 'scale_profile.connector' and entity_id = 'kretz-1') <> 1 then raise exception 'auditoría del vínculo'; end if;
  perform public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'systel-1', '00000000-0000-0000-0000-0000000f20c1', '{"id":"com7","kind":"serial","path":"COM7"}');
end $$;

-- 3. Estado para la web: quienes encolan (la cajera sí, solo lectura no), con "en línea" del servidor.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2008', true);
select pg_temp.must_fail($q$select public.scale_connect_status('00000000-0000-0000-0000-0000000f2002')$q$, 'solo lectura');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2006', true);
do $$
declare r jsonb;
begin
  perform pg_temp.must_fail($q$select public.scale_connect_status('00000000-0000-0000-0000-0000000f2003')$q$, 'cajera en otro local');
  perform pg_temp.must_fail($q$select public.scale_connect_status('00000000-0000-0000-0000-0000000f2012')$q$, 'sucursal de B');
  r := public.scale_connect_status('00000000-0000-0000-0000-0000000f2002');
  if jsonb_array_length(r -> 'connectors') <> 1 or r -> 'connectors' -> 0 ->> 'name' <> 'Caja 1' or not (r -> 'connectors' -> 0 ->> 'online')::boolean then raise exception 'estado: %', r; end if;
  if jsonb_array_length(r -> 'bindings') <> 2 then raise exception 'vínculos: %', r; end if;
end $$;
reset role;
update scale_connectors set last_seen_at = now() - interval '3 minutes' where id = '00000000-0000-0000-0000-0000000f20c1';
set local role authenticated;
do $$
begin
  if (public.scale_connect_status('00000000-0000-0000-0000-0000000f2002') -> 'bindings' -> 0 ->> 'online')::boolean then raise exception 'latido de 3 minutos = en línea'; end if;
end $$;

-- 4. Configuración del conector: el puerto solo de SUS balanzas.
reset role;
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.scale_connector_config('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'));
  if (select count(*) from jsonb_array_elements(r -> 'scales') e(x) where e.x -> 'device' ->> 'id' is not null) <> 2 then raise exception 'config con puertos: %', r; end if;
  r := public.scale_connector_config('00000000-0000-0000-0000-0000000f20c2', pg_temp.h('s2'));
  if (select count(*) from jsonb_array_elements(r -> 'scales') e(x) where e.x -> 'device' <> 'null'::jsonb) <> 0 then raise exception 'PC Norte ve puertos ajenos: %', r; end if;
end $$;

-- 5. Encolar: la cajera manda a la Report; el dueño a la Cuora.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2006', true);
select set_config('test.job_cajera', public.queue_scale_job('kretz-1', 'send',
  '{"products":[{"product_id":"00000000-0000-0000-0000-0000000f200a","plu":"1","name":"Nalga","price":18000}]}', null, '00000000-0000-0000-0000-0000000f20c1')::text, false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2005', true);
select set_config('test.job_duenio', public.queue_scale_job('systel-1', 'send', '{"products":[]}', null, '00000000-0000-0000-0000-0000000f20c1')::text, false);
select set_config('test.job_cola', public.queue_scale_job('kretz-1', 'send', '{"products":[]}', null, '00000000-0000-0000-0000-0000000f20c1')::text, false);
select set_config('request.jwt.claim.sub', '', true);

reset role;
set local role service_role;
do $$
declare r jsonb; j1 uuid := current_setting('test.job_cajera')::uuid; j2 uuid := current_setting('test.job_duenio')::uuid;
begin
  -- Antes de tomarlo: el motor no anda con un trabajo en cola.
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'list_branch_scales')$q$, '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1), 'trabajo en cola', 'PT409');
  -- Los tres se encolaron en la misma transacción (misma hora): se toman los tres y se usan los dos primeros.
  for i in 1..3 loop
    if public.scale_connector_claim_job('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1')) is null then raise exception 'no tomó el %', i; end if;
  end loop;
  if (select count(*) from scale_jobs where id in (j1, j2) and status = 'running') <> 2 then raise exception 'no quedaron tomados'; end if;

  -- Credencial, PC ajena y otra empresa.
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'list_branch_scales')$q$, '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('otro'), j1), 'secreto malo', 'PT401');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'list_branch_scales')$q$, '00000000-0000-0000-0000-0000000f20c2', pg_temp.h('s2'), j1), 'otra PC de A', 'PT404');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'list_branch_scales')$q$, '00000000-0000-0000-0000-0000000f20cb', pg_temp.h('sb'), j1), 'PC de B', 'PT404');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'borrar_todo')$q$, '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1), 'acción desconocida', 'P0001');

  -- Lecturas: solo la sucursal del trabajo.
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1, 'list_branch_scales');
  if jsonb_array_length(r -> 'scales') <> 2 then raise exception 'balanzas de la sucursal: %', r; end if;
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1, 'load_branch_config');
  if r -> 'config' <> 'null'::jsonb then raise exception 'formato inexistente: %', r; end if;
  -- Otra balanza que la del trabajo: no (y nunca con PT403, que borraría la credencial).
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'load_scale_setup', '{"scale_key":"systel-1"}')$q$, '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1), 'otra balanza', 'P0001');

  -- Escritura como la cajera: el formato de etiqueta (permitido a la cajera, como en la web) con su auditoría.
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1, 'save_branch_config',
         '{"config":{"prefixLength":2,"pluLength":5,"weightLength":5,"weightDivisor":1000,"totalLength":13,"payloadType":"weight"}}');
  if (select plu_length from branch_scale_configs where branch_id = '00000000-0000-0000-0000-0000000f2002') <> 5 then raise exception 'no guardó el formato'; end if;
  if coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' then raise exception 'quedó el usuario puesto después del motor'; end if;
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1, 'load_branch_config');
  if (r -> 'config' ->> 'plu_length')::int <> 5 then raise exception 'relectura del formato: %', r; end if;
  -- El catálogo Systel: la cajera no puede desde la web, tampoco por Scale Connect.
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'save_scale_catalog', '{"scale_key":"kretz-1","profile":{"brand":"kretz"},"items":[{"code":1,"name":"Nalga","sale_type":"P","prices":[18000]}]}')$q$,
    '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1), 'cajera guarda catálogo', 'P0001');
  -- Reporte a soporte: cualquier rol, como en la web (migración 128).
  perform public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j1, 'report', '{"note":"x","log_text":"y"}');

  -- Como el dueño: catálogo, vínculos, encendido y reporte.
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'save_scale_catalog',
         '{"scale_key":"systel-1","profile":{"brand":"systel","model":"cuora","weighed_format":"20PPPPPIIIIIC","amount_decimals":0,"generic_codes":[]},
           "items":[{"code":1,"name":"NALGA","sale_type":"P","prices":[18000]},{"code":2,"name":"VACIO","sale_type":"P","prices":[15000]}]}');
  if (r -> 'result' ->> 'items')::int <> 2 then raise exception 'catálogo: %', r; end if;
  if (select user_id from audit_log where action = 'scale_catalog.save' and entity_id = 'systel-1' order by created_at desc limit 1) <> '00000000-0000-0000-0000-0000000f2005' then
    raise exception 'la auditoría no quedó a nombre de quien encoló';
  end if;
  perform public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'set_scale_links',
    '{"scale_key":"systel-1","links":[{"code":1,"kind":"product","product_id":"00000000-0000-0000-0000-0000000f200a"},{"code":2,"kind":"libre"}]}');
  if (select product_id from scale_catalog_items where scale_key = 'systel-1' and code = 1) <> '00000000-0000-0000-0000-0000000f200a' then raise exception 'vínculo'; end if;
  perform public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'set_scale_profile_active', '{"scale_key":"systel-1","active":false}');
  if (select active from scale_profiles where scale_key = 'systel-1') then raise exception 'no se apagó'; end if;
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'load_scale_setup', '{"scale_key":"systel-1"}');
  if r -> 'profile' ->> 'weighed_format' <> '20PPPPPIIIIIC' or jsonb_array_length(r -> 'items') <> 2 or r -> 'items' -> 0 ->> 'link_kind' <> 'product' then raise exception 'setup: %', r; end if;
  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'report', '{"note":"Scale Connect: no contesta","log_text":"{\"pasos\":[]}"}');
  if (select count(*) from scale_support_reports where company_id = '00000000-0000-0000-0000-0000000f2001') <> 2 then raise exception 'reporte a soporte'; end if;

  -- Cerrado el trabajo, el motor no anda más con él.
  perform public.scale_connector_finish_job('00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2, 'done');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'set_scale_profile_active', '{"scale_key":"systel-1","active":true}')$q$, '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), j2), 'trabajo cerrado', 'PT409');
end $$;

-- 6. Si quien encoló ya no está activo, no se escribe en su nombre.
reset role;
update profiles set active = false where id = '00000000-0000-0000-0000-0000000f2006';
set local role service_role;
do $$
begin
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'save_branch_config', '{"config":{"prefixLength":2,"pluLength":5,"weightLength":5,"weightDivisor":1000,"totalLength":13}}')$q$,
    '00000000-0000-0000-0000-0000000f20c1', pg_temp.h('s1'), current_setting('test.job_cajera')), 'usuario dado de baja', 'P0001');
end $$;

-- 7. Desvincular la PC: la balanza deja de figurar en el estado.
reset role;
update profiles set active = true where id = '00000000-0000-0000-0000-0000000f2006';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2005', true);
do $$
begin
  perform public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2002', 'systel-1', null);
  if (select connector_id from scale_profiles where scale_key = 'systel-1') is not null then raise exception 'no se desvinculó'; end if;
  perform public.revoke_scale_connector('00000000-0000-0000-0000-0000000f20c1');
  if jsonb_array_length(public.scale_connect_status('00000000-0000-0000-0000-0000000f2002') -> 'bindings') <> 0 then raise exception 'PC revocada sigue con balanzas'; end if;
end $$;

reset role;
rollback;
