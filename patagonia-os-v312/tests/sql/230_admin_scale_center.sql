-- Pruebas de la migración 230 (Centro de diagnóstico de balanzas del panel de plataforma). Se deshace al final.
--   0. Permisos: anon no ejecuta nada; las internas no las ejecuta authenticated; security definer + search_path.
--   1. Un dueño de empresa (no administrador de plataforma) no ve nada.
--   2. El administrador ve TODAS las empresas, con el semáforo y el motivo.
--   3. Detalle de una empresa: balanzas, conectores (sin hashes), envíos, productos fallados, reportes.
--   4. El registro técnico sale limpio (sin contraseña, token, email, teléfono, CUIT ni importes) y sigue siendo JSON.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000f3001', 'Carnicería Roja 230', 9951, 'estandar', array['balanzas_v2']),
  ('00000000-0000-0000-0000-0000000f3002', 'Granja Verde 230', 9952, 'full', '{}'),
  ('00000000-0000-0000-0000-0000000f3003', 'Pollería Amarilla 230', 9953, 'basico', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f3011', '00000000-0000-0000-0000-0000000f3001', 'Centro'),
  ('00000000-0000-0000-0000-0000000f3012', '00000000-0000-0000-0000-0000000f3002', 'Única'),
  ('00000000-0000-0000-0000-0000000f3013', '00000000-0000-0000-0000-0000000f3003', 'Barrio');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f3021', 'duenio@230'),
  ('00000000-0000-0000-0000-0000000f3022', 'soporte@230');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f3021', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 'Dueño Roja', 'owner');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000f3022');

-- Roja: 2 Kretz + 1 Systel, dos con la misma identidad (repetidas), una PC vieja, último envío fallado.
insert into scale_profiles (company_id, branch_id, scale_key, brand, model, name, family, identity) values
  ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 'k1', 'kretz', 'Report LT', 'Report Caja 1', 'kretz', '{"serie":"A1"}'),
  ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 'k2', 'kretz', 'Report LT', 'Report otra vez', 'kretz', '{"serie":"A1"}'),
  ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 's1', 'systel', 'Cuora Max', 'Systel', 'systel', '{"serie":"S9"}'),
  ('00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f3012', 'k1', 'kretz', 'Aura', 'Aura', 'kretz', '{}'),
  ('00000000-0000-0000-0000-0000000f3003', '00000000-0000-0000-0000-0000000f3013', 'k1', 'kretz', 'Report LT', 'Report', 'kretz', '{}');
insert into scale_connectors (id, company_id, branch_id, name, secret_hash, version, last_seen_at) values
  ('00000000-0000-0000-0000-0000000f30c1', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 'Caja 1',
   encode(sha256(convert_to('s1', 'UTF8')), 'hex'), '0.9.0', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000f30c2', '00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f3012', 'Mostrador',
   encode(sha256(convert_to('s2', 'UTF8')), 'hex'), '0.10.0', now() - interval '30 seconds');
update scale_profiles set connector_id = '00000000-0000-0000-0000-0000000f30c1', connector_device = '{"com":"COM3","usb":"FTDI A10K"}'
 where company_id = '00000000-0000-0000-0000-0000000f3001' and scale_key = 'k1';

insert into scale_jobs (id, company_id, branch_id, scale_key, kind, status, requested_count, confirmed_count, failed_count, started_at, finished_at, error_code) values
  ('00000000-0000-0000-0000-0000000f30a1', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 's1', 'send', 'partial', 10, 6, 4, now() - interval '2 days', now() - interval '2 days', 'envio'),
  ('00000000-0000-0000-0000-0000000f30a2', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', 's1', 'send', 'failed', 10, 0, 10, now() - interval '1 hour', now() - interval '1 hour', 'frenado'),
  ('00000000-0000-0000-0000-0000000f30a3', '00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f3012', 'k1', 'send', 'done', 50, 50, 0, now() - interval '3 hours', now() - interval '3 hours', null),
  ('00000000-0000-0000-0000-0000000f30a4', '00000000-0000-0000-0000-0000000f3003', '00000000-0000-0000-0000-0000000f3013', 'k1', 'send', 'partial', 20, 18, 2, now() - interval '5 hours', now() - interval '5 hours', null);
insert into scale_job_items (job_id, company_id, plu, action, status, reason) values
  ('00000000-0000-0000-0000-0000000f30a1', '00000000-0000-0000-0000-0000000f3001', '12', 'write', 'failed', 'la balanza rechazó el alta (respuesta 21)'),
  ('00000000-0000-0000-0000-0000000f30a2', '00000000-0000-0000-0000-0000000f3001', '12', 'write', 'failed', 'la balanza rechazó el alta (respuesta 21)'),
  ('00000000-0000-0000-0000-0000000f30a2', '00000000-0000-0000-0000-0000000f3001', '40', 'write', 'failed', 'E5'),
  ('00000000-0000-0000-0000-0000000f30a2', '00000000-0000-0000-0000-0000000f3001', '41', 'write', 'confirmed', null);

-- Un reporte con datos que NO tienen que salir.
insert into scale_support_reports (id, company_id, branch_id, user_id, note, log_text, connections) values
  ('00000000-0000-0000-0000-0000000f30e1', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', '00000000-0000-0000-0000-0000000f3021',
   'Mis balanzas (Systel) · sincronizar (frenado): llamame al 11 2787-1634',
   '{"cuando":"2026-11-27T10:00:00Z","etapa":"sincronizar (frenado)","mensaje":"4 productos no quedaron bien en la balanza (respuesta 21)","tecnico":"token=abcDEF1234567890 Bearer eyJhbGciOi.eyJzdWIiOi.firma","cable":{"ip":"169.254.137.200","com":"COM3"},"email":"duenio@carniceria.com","password":"Secreta123","importe":15300,"detalle":"cobró $ 12.345,50 a CUIT 20-12345678-9, mail otro@gmail.com, +54 9 299 555-1234","x":"00000000-0000-0000-0000-0000000f30c1.AbCdEfGhIjKlMnOpQrStUv","pasos":["abrir puerto","07 30 30 30 31 04"]}',
   '[{"displayName":"Systel","settings":{"apiKey":"clave-de-prueba-AbC123xyZ987LmNoPqRsTuVw"}}]'),
  ('00000000-0000-0000-0000-0000000f30e2', '00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3011', '00000000-0000-0000-0000-0000000f3021',
   null, 'Actividad vieja en texto suelto: No elegiste la balanza en la lista', '[]');
update scale_support_reports set resolved_at = now() where id = '00000000-0000-0000-0000-0000000f30e2';

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
grant execute on function pg_temp.must_fail(text, text, text) to authenticated, anon;

-- 0. Permisos.
do $$
declare
  f text;
begin
  foreach f in array array['public.admin_scale_overview()', 'public.admin_scale_company_detail(uuid)', 'public.admin_scale_report_log(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception 'anon ejecuta %', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'authenticated no ejecuta %', f; end if;
    if (select prosecdef from pg_proc where oid = f::regprocedure) is not true then raise exception '% no es security definer', f; end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and 'search_path=public' = any (proconfig)) then raise exception '% sin search_path fijo', f; end if;
  end loop;
  foreach f in array array['public.admin_scale_redact(text)', 'public.admin_scale_try_json(text)', 'public.admin_scale_semver(text)'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then raise exception 'interna % expuesta', f; end if;
  end loop;
  if not exists (select 1 from public.schema_migrations where version = '230_admin_scale_center') then raise exception 'falta schema_migrations'; end if;
  if public.admin_scale_semver('0.10.2') <= public.admin_scale_semver('0.9.0') then raise exception 'semver ordena mal'; end if;
end $$;

-- 1. Un dueño de empresa no ve nada (ni siquiera su propia empresa).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3021', true);
select pg_temp.must_fail('select * from public.admin_scale_overview()', 'dueño ve el resumen', '42501');
select pg_temp.must_fail($q$select public.admin_scale_company_detail('00000000-0000-0000-0000-0000000f3001')$q$, 'dueño ve el detalle', '42501');
select pg_temp.must_fail($q$select public.admin_scale_report_log('00000000-0000-0000-0000-0000000f30e1')$q$, 'dueño ve el registro', '42501');
-- Sin sesión tampoco.
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.must_fail('select * from public.admin_scale_overview()', 'sin sesión ve el resumen', '42501');
reset role;

-- 2. El administrador ve todas las empresas.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3022', true);
do $$
declare
  r record;
  n int;
begin
  select count(*) into n from public.admin_scale_overview() o
   where o.company_id in ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f3003');
  if n <> 3 then raise exception 'el administrador ve % de 3 empresas', n; end if;

  select * into r from public.admin_scale_overview() o where o.company_id = '00000000-0000-0000-0000-0000000f3001';
  if r.light <> 'rojo' or r.light_reason <> 'Falló el último envío a la balanza' then raise exception 'Roja: % / %', r.light, r.light_reason; end if;
  if r.scales_active <> 3 or (r.scales_by_brand ->> 'kretz')::int <> 2 or (r.scales_by_brand ->> 'systel')::int <> 1 then raise exception 'Roja balanzas: % %', r.scales_active, r.scales_by_brand; end if;
  if r.duplicate_groups <> 1 then raise exception 'Roja repetidas: %', r.duplicate_groups; end if;
  if not r.balanzas_v2 or r.plan <> 'estandar' or r.branch_name <> 'Centro' then raise exception 'Roja datos: % % %', r.balanzas_v2, r.plan, r.branch_name; end if;
  if r.connectors_active <> 1 or r.connectors_online <> 0 or r.connectors_stale <> 1 then raise exception 'Roja conectores: % % %', r.connectors_active, r.connectors_online, r.connectors_stale; end if;
  if r.jobs_failed_7d <> 1 or r.last_job_status <> 'failed' or r.last_job_requested <> 10 then raise exception 'Roja envíos: % % %', r.jobs_failed_7d, r.last_job_status, r.last_job_requested; end if;
  if r.reports_open <> 1 or r.last_open_report_stage <> 'sincronizar (frenado)' then raise exception 'Roja reportes: % %', r.reports_open, r.last_open_report_stage; end if;

  select * into r from public.admin_scale_overview() o where o.company_id = '00000000-0000-0000-0000-0000000f3002';
  if r.light <> 'verde' or r.connectors_online <> 1 or r.connector_version_max <> '0.10.0' then raise exception 'Verde: % % %', r.light, r.connectors_online, r.connector_version_max; end if;

  select * into r from public.admin_scale_overview() o where o.company_id = '00000000-0000-0000-0000-0000000f3003';
  if r.light <> 'amarillo' or r.light_reason <> 'El último envío quedó a medias (18 de 20 confirmados)' then raise exception 'Amarilla: % / %', r.light, r.light_reason; end if;
end $$;

-- 3. Detalle.
do $$
declare
  d jsonb;
  t text;
begin
  d := public.admin_scale_company_detail('00000000-0000-0000-0000-0000000f3001');
  if jsonb_array_length(d -> 'scales') <> 3 then raise exception 'detalle balanzas: %', d -> 'scales'; end if;
  if not exists (select 1 from jsonb_array_elements(d -> 'scales') s where s ->> 'scale_key' = 'k1' and s ->> 'connector_name' = 'Caja 1' and s -> 'connector_device' ->> 'com' = 'COM3') then
    raise exception 'detalle sin PC/puerto'; end if;
  if jsonb_array_length(d -> 'connectors') <> 1 or (d -> 'connectors' -> 0 ->> 'online')::boolean then raise exception 'detalle conectores: %', d -> 'connectors'; end if;
  t := d::text;
  if t ~ 'secret_hash|fingerprint_hash' or t like '%' || encode(sha256(convert_to('s1', 'UTF8')), 'hex') || '%' then raise exception 'el detalle muestra hashes'; end if;
  if jsonb_array_length(d -> 'jobs') <> 2 or d -> 'jobs' -> 0 ->> 'error_code' <> 'frenado' then raise exception 'detalle envíos: %', d -> 'jobs'; end if;
  if d -> 'failed_products' -> 0 ->> 'product' <> 'PLU 12' or (d -> 'failed_products' -> 0 ->> 'times')::int <> 2 then raise exception 'detalle fallados: %', d -> 'failed_products'; end if;
  if jsonb_array_length(d -> 'failed_products') <> 2 then raise exception 'detalle fallados (confirmado contado): %', d -> 'failed_products'; end if;
  if jsonb_array_length(d -> 'reports') <> 2 then raise exception 'detalle reportes: %', d -> 'reports'; end if;
  if d -> 'reports' -> 0 ->> 'etapa' <> 'sincronizar (frenado)' or d -> 'reports' -> 0 ->> 'mensaje' not like '4 productos no quedaron bien%' then raise exception 'detalle etapa/mensaje: %', d -> 'reports' -> 0; end if;
  if d -> 'reports' -> 0 ->> 'tecnico' ~ 'abcDEF1234567890|eyJ' then raise exception 'detalle técnico sin limpiar: %', d -> 'reports' -> 0 ->> 'tecnico'; end if;
  if d -> 'reports' -> 0 ->> 'note' ~ '2787' then raise exception 'detalle nota con teléfono: %', d -> 'reports' -> 0 ->> 'note'; end if;
  if (d ->> 'ambiguities_supported')::boolean then raise exception 'ambigüedades'; end if;
  -- Empresa de otro: también la ve (es administrador), y una que no existe falla.
  d := public.admin_scale_company_detail('00000000-0000-0000-0000-0000000f3002');
  if jsonb_array_length(d -> 'scales') <> 1 then raise exception 'detalle Verde'; end if;
end $$;
select pg_temp.must_fail($q$select public.admin_scale_company_detail('00000000-0000-0000-0000-0000000f3999')$q$, 'empresa inexistente');

-- 4. El registro técnico sale limpio.
do $$
declare
  d jsonb;
  t text;
  j jsonb;
  bad text;
begin
  d := public.admin_scale_report_log('00000000-0000-0000-0000-0000000f30e1');
  t := d ->> 'log_text';
  foreach bad in array array['Secreta123', 'abcDEF1234567890', 'eyJhbGciOi', 'duenio@carniceria.com', 'otro@gmail.com', '2787-1634', '555-1234',
                             '20-12345678-9', '12.345', '15300', 'AbCdEfGhIjKlMnOpQrStUv', 'clave-de-prueba-AbC123'] loop
    if strpos(t, bad) > 0 or strpos(d::text, bad) > 0 then raise exception 'el registro muestra "%": %', bad, d; end if;
  end loop;
  -- Lo técnico queda: etapa, mensaje, IP, COM y los bytes.
  foreach bad in array array['sincronizar (frenado)', 'respuesta 21', '169.254.137.200', 'COM3', '07 30 30 30 31 04', '2026-11-27T10:00:00Z'] loop
    if strpos(t, bad) = 0 then raise exception 'el registro perdió "%": %', bad, t; end if;
  end loop;
  j := t::jsonb; -- sigue siendo JSON válido
  if j ->> 'password' <> '[oculto]' or j ->> 'importe' <> '[oculto]' then raise exception 'claves sensibles: %', j; end if;
  if jsonb_typeof(d -> 'connections') <> 'array' then raise exception 'conexiones: %', d -> 'connections'; end if;
  -- El reporte viejo (texto suelto) también se lee.
  d := public.admin_scale_report_log('00000000-0000-0000-0000-0000000f30e2');
  if d ->> 'log_text' not like '%No elegiste la balanza%' then raise exception 'reporte de texto: %', d; end if;
end $$;
select pg_temp.must_fail($q$select public.admin_scale_report_log('00000000-0000-0000-0000-0000000f3999')$q$, 'reporte inexistente');
reset role;

-- 5. "Marcar resuelto" sigue siendo la RPC de la 100 (el centro no escribe): el resumen lo refleja.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3022', true);
select public.set_scale_support_report_resolved('00000000-0000-0000-0000-0000000f30e1', true);
do $$
begin
  if (select o.reports_open from public.admin_scale_overview() o where o.company_id = '00000000-0000-0000-0000-0000000f3001') <> 0 then
    raise exception 'el reporte resuelto sigue abierto'; end if;
end $$;
reset role;

rollback;
