-- Pruebas de la migración 229 (Scale Connect: versiones publicadas, canal por empresa, porcentaje de despliegue y
-- resultado de cada PC). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000f2901', 'Carnicería 229', 9951, 'estandar'),
  ('00000000-0000-0000-0000-0000000f2911', 'Otra 229', 9952, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f2902', '00000000-0000-0000-0000-0000000f2901', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f2905', 'duenio@229'),
  ('00000000-0000-0000-0000-0000000f2906', 'plataforma@229');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f2905', '00000000-0000-0000-0000-0000000f2901', '00000000-0000-0000-0000-0000000f2902', 'Dueño', 'owner');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000f2906');

create function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
-- 40 PC de la empresa (para el porcentaje) + una de la otra empresa.
insert into scale_connectors (id, company_id, branch_id, name, secret_hash, version)
select ('00000000-0000-0000-0000-0000' || lpad(to_hex(i), 8, '0'))::uuid, '00000000-0000-0000-0000-0000000f2901',
       '00000000-0000-0000-0000-0000000f2902', 'Caja ' || i, pg_temp.h('s' || i), '0.2.1'
from generate_series(1, 40) i;
insert into scale_connectors (id, company_id, name, secret_hash, version) values
  ('00000000-0000-0000-0000-0000000f29c9', '00000000-0000-0000-0000-0000000f2911', 'Otra PC', pg_temp.h('otra'), '0.2.1');

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
-- Un latest.json con la forma del CI (la firma la verifica la PC, no la base).
create function pg_temp.mf(p_version text, p_channel text, p_sha text default null, p_min text default '0.1.0') returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema', 1, 'product', 'patagonia-scale-connect', 'version', p_version, 'channel', p_channel, 'minVersion', p_min,
    'url', 'https://xyz.supabase.co/storage/v1/object/public/scale-connect/' || p_version || '/PatagoniaScaleConnect-Setup-' || p_version || '.exe',
    'sha256', coalesce(p_sha, encode(sha256(convert_to(p_version, 'UTF8')), 'hex')), 'size', 41234567,
    'publishedAt', '2026-11-27T12:00:00.000Z', 'keyId', '0123456789abcdef', 'signature', repeat('A', 86) || '==')
$$;
create function pg_temp.offer(p_n integer, p_current text default null) returns jsonb language sql as $$
  select public.scale_connector_update_offer(('00000000-0000-0000-0000-0000' || lpad(to_hex(p_n), 8, '0'))::uuid, pg_temp.h('s' || p_n), p_current)
$$;
grant execute on function pg_temp.must_fail(text, text, text) to authenticated, service_role, anon;
grant execute on function pg_temp.mf(text, text, text, text) to authenticated, service_role, anon;
grant execute on function pg_temp.h(text) to authenticated, service_role;
grant execute on function pg_temp.offer(integer, text) to service_role;

-- 0. Permisos.
do $$
begin
  if has_function_privilege('authenticated', 'public.scale_connector_update_offer(uuid, text, text)', 'execute') then raise exception 'authenticated pide ofertas'; end if;
  if has_function_privilege('anon', 'public.scale_connector_update_offer(uuid, text, text)', 'execute') then raise exception 'anon pide ofertas'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_report_update(uuid, text, jsonb)', 'execute') then raise exception 'authenticated informa'; end if;
  if not has_function_privilege('service_role', 'public.scale_connector_update_offer(uuid, text, text)', 'execute') then raise exception 'service_role sin oferta'; end if;
  if not has_function_privilege('service_role', 'public.scale_connector_report_update(uuid, text, jsonb)', 'execute') then raise exception 'service_role sin informe'; end if;
  if has_function_privilege('authenticated', 'public.scale_connect_offer_for(public.scale_connectors, text)', 'execute') then raise exception 'authenticated usa offer_for'; end if;
  if has_function_privilege('authenticated', 'public.scale_connect_rollout_bucket(uuid)', 'execute') then raise exception 'authenticated usa el balde'; end if;
  if has_function_privilege('anon', 'public.publish_scale_connect_release(jsonb, text, integer)', 'execute') then raise exception 'anon publica'; end if;
  if has_function_privilege('anon', 'public.set_company_scale_connect_channel(uuid, text)', 'execute') then raise exception 'anon cambia canal'; end if;
  if has_table_privilege('authenticated', 'public.scale_connect_releases', 'select') then raise exception 'authenticated lee las versiones'; end if;
  if has_table_privilege('authenticated', 'public.scale_connect_releases', 'insert') then raise exception 'authenticated escribe versiones'; end if;
  if (select prosecdef from pg_proc where oid = 'public.publish_scale_connect_release(jsonb, text, integer)'::regprocedure) is not true then raise exception 'publish sin security definer'; end if;
  if not exists (select 1 from pg_proc where oid = 'public.scale_connector_update_offer(uuid, text, text)'::regprocedure and 'search_path=public' = any (proconfig)) then raise exception 'oferta sin search_path'; end if;
  if (select scale_connect_channel from companies where id = '00000000-0000-0000-0000-0000000f2901') <> 'stable' then raise exception 'el canal por omisión no es stable'; end if;
  if not exists (select 1 from public.schema_migrations where version = '229_scale_connect_releases') then raise exception 'falta schema_migrations'; end if;
  if not exists (select 1 from storage.buckets where id = 'scale-connect' and public) then raise exception 'falta el bucket público'; end if;
  -- Nadie sube por la API: ninguna política de storage.objects menciona el bucket (solo la clave de servicio del CI).
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
             and (coalesce(qual, '') like '%scale-connect%' or coalesce(with_check, '') like '%scale-connect%')) then
    raise exception 'hay una política de escritura en el bucket';
  end if;
end $$;

-- 1. Versiones y balde.
do $$
begin
  if public.scale_connect_version_key('0.10.0') <= public.scale_connect_version_key('0.9.9') then raise exception '0.10.0 <= 0.9.9'; end if;
  if public.scale_connect_version_key('1.2.3-beta') <> array[1, 2, 3] then raise exception 'sufijo'; end if;
  if public.scale_connect_version_key('1.2') is not null or public.scale_connect_version_key('x') is not null then raise exception 'versión inválida aceptada'; end if;
  if public.scale_connect_rollout_bucket('00000000-0000-0000-0000-000000000001') <> public.scale_connect_rollout_bucket('00000000-0000-0000-0000-000000000001') then raise exception 'balde inestable'; end if;
  if (select min(public.scale_connect_rollout_bucket(id)) from scale_connectors) < 0 or (select max(public.scale_connect_rollout_bucket(id)) from scale_connectors) > 99 then raise exception 'balde fuera de 0..99'; end if;
  if (select count(distinct public.scale_connect_rollout_bucket(id)) from scale_connectors) < 20 then raise exception 'el balde no reparte'; end if;
end $$;

-- 2. Solo administradores de plataforma publican y cambian canales.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2905', true);
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general'), 'stable', 100)$$, 'el dueño publica', '42501');
select pg_temp.must_fail($$select public.set_company_scale_connect_channel('00000000-0000-0000-0000-0000000f2901', 'pilot')$$, 'el dueño se pasa a piloto', '42501');
do $$ begin if public.list_scale_connect_releases() is not null then raise exception 'el dueño lista versiones'; end if; end $$;
select pg_temp.must_fail($$select count(*) from public.scale_connect_releases$$, 'el dueño lee la tabla');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2906', true);
-- Formas inválidas.
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general') - 'signature', 'stable', 100)$$, 'sin firma');
select pg_temp.must_fail($$select public.publish_scale_connect_release(jsonb_set(pg_temp.mf('0.3.0', 'general'), '{url}', '"http://x/y.exe"'), 'stable', 100)$$, 'url http');
select pg_temp.must_fail($$select public.publish_scale_connect_release(jsonb_set(pg_temp.mf('0.3.0', 'general'), '{product}', '"otro"'), 'stable', 100)$$, 'otro producto');
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general', null, '0.4.0'), 'stable', 100)$$, 'minVersion mayor');
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general'), 'beta', 100)$$, 'canal inventado');
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general'), 'stable', 101)$$, 'porcentaje 101');
-- Un manifiesto firmado para piloto no va a estable.
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'piloto'), 'stable', 100)$$, 'piloto en estable');

-- 0.3.0 piloto al 100 % y 0.3.0 estable al 0 %.
select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'piloto'), 'pilot', 100);
select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general'), 'stable', 0);
-- Misma versión y canal con OTRO instalador: no (hay que subir la versión).
select pg_temp.must_fail($$select public.publish_scale_connect_release(pg_temp.mf('0.3.0', 'general', repeat('c', 64)), 'stable', 0)$$, 'cambiar el binario de una versión');
do $$ begin if jsonb_array_length(public.list_scale_connect_releases()) <> 2 then raise exception 'lista de versiones'; end if; end $$;
reset role;
do $$
begin
  if (select count(*) from scale_connect_release_log where action = 'publish' and user_id = '00000000-0000-0000-0000-0000000f2906') <> 2 then raise exception 'historial de publicación'; end if;
end $$;

-- 3. Ofertas: empresa estable, 0.3.0 estable al 0 % → nadie. La piloto no le llega.
set local role service_role;
do $$
begin
  for i in 1..40 loop
    if pg_temp.offer(i) -> 'offer' <> 'null'::jsonb then raise exception 'PC % recibió oferta al 0 %%', i; end if;
  end loop;
  if pg_temp.offer(1) ->> 'channel' <> 'stable' then raise exception 'canal informado'; end if;
end $$;
reset role;

-- 4. Porcentaje: al 50 % entran exactamente las PC con balde < 50; al 80 % siguen esas y se suman otras.
update scale_connect_releases set rollout_percent = 50 where version = '0.3.0' and channel = 'stable';
create temp table first_wave as
select i, (public.scale_connect_rollout_bucket(('00000000-0000-0000-0000-0000' || lpad(to_hex(i), 8, '0'))::uuid) < 50) as expected
from generate_series(1, 40) i;
grant select on first_wave to service_role;
set local role service_role;
do $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from first_wave loop
    if (pg_temp.offer(r.i) -> 'offer' <> 'null'::jsonb) <> r.expected then raise exception 'PC %: balde y oferta no coinciden', r.i; end if;
    if r.expected then
      n := n + 1;
      if pg_temp.offer(r.i) #>> '{offer,version}' <> '0.3.0' or pg_temp.offer(r.i) #>> '{offer,channel}' <> 'stable' then raise exception 'oferta equivocada'; end if;
      if pg_temp.offer(r.i) #>> '{offer,manifest,signature}' is null then raise exception 'la oferta no lleva el manifiesto firmado'; end if;
    end if;
  end loop;
  if n = 0 or n = 40 then raise exception 'el 50 %% no partió nada (%)', n; end if;
end $$;
reset role;
update scale_connect_releases set rollout_percent = 80 where version = '0.3.0' and channel = 'stable';
set local role service_role;
do $$
declare
  r record;
begin
  for r in select * from first_wave where expected loop
    if pg_temp.offer(r.i) -> 'offer' = 'null'::jsonb then raise exception 'PC % salió al subir el porcentaje', r.i; end if;
  end loop;
end $$;

-- 5. Nunca una versión vieja ni la misma: con 0.3.0 (o 0.4.0) instalada no hay oferta.
do $$
begin
  for i in 1..40 loop
    if pg_temp.offer(i, '0.3.0') -> 'offer' <> 'null'::jsonb then raise exception 'ofreció la misma versión'; end if;
    if pg_temp.offer(i, '0.4.0') -> 'offer' <> 'null'::jsonb then raise exception 'ofreció bajar de versión'; end if;
  end loop;
end $$;
reset role;

-- 6. Empresa piloto: recibe la piloto (al 100 %) aunque la estable no le toque.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2906', true);
select public.set_company_scale_connect_channel('00000000-0000-0000-0000-0000000f2901', 'pilot');
reset role;
set local role service_role;
do $$
begin
  for i in 1..40 loop
    if pg_temp.offer(i) #>> '{offer,version}' is distinct from '0.3.0' then raise exception 'la PC % piloto no recibió la 0.3.0', i; end if;
  end loop;
  if pg_temp.offer(1) ->> 'channel' <> 'pilot' then raise exception 'canal piloto'; end if;
  -- La otra empresa sigue estable y la piloto no le llega.
  if public.scale_connector_update_offer('00000000-0000-0000-0000-0000000f29c9', pg_temp.h('otra'), null) ->> 'channel' <> 'stable' then raise exception 'la otra empresa cambió'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from audit_log where action = 'scale_connect.channel' and company_id = '00000000-0000-0000-0000-0000000f2901') then raise exception 'falta la auditoría del canal'; end if;
end $$;

-- 7. Frenar: la piloto inactiva y la estable al 0 % → nadie.
create temp table rel_ids as select id, channel from scale_connect_releases;
grant select on rel_ids to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2906', true);
do $$
begin
  perform public.set_scale_connect_release((select id from rel_ids where channel = 'pilot'), false);
  perform public.set_scale_connect_release((select id from rel_ids where channel = 'stable'), true, 0);
end $$;
select pg_temp.must_fail($$select public.set_scale_connect_release('00000000-0000-0000-0000-000000000000', false)$$, 'versión inexistente');
reset role;
set local role service_role;
do $$
begin
  for i in 1..40 loop
    if pg_temp.offer(i) -> 'offer' <> 'null'::jsonb then raise exception 'frenada y la PC % igual la recibe', i; end if;
  end loop;
end $$;

-- 8. Credencial: la de otra PC o revocada no sirve.
select pg_temp.must_fail($$select public.scale_connector_update_offer('00000000-0000-0000-0000-000000000001', pg_temp.h('s2'), null)$$, 'secreto de otra PC', 'PT401');

-- 9. Resultado de la PC: se guarda acotado; lo grave queda en audit_log; lo inválido no entra.
select pg_temp.must_fail($$select public.scale_connector_report_update('00000000-0000-0000-0000-000000000001', pg_temp.h('s1'), '{"result":"hackeada"}')$$, 'resultado inventado');
select public.scale_connector_report_update('00000000-0000-0000-0000-000000000001', pg_temp.h('s1'),
  jsonb_build_object('result', 'revertida', 'from', '0.2.1', 'to', '0.3.0', 'message', repeat('x', 900), 'extra', 'no'));
select public.scale_connector_report_update('00000000-0000-0000-0000-000000000002', pg_temp.h('s2'),
  jsonb_build_object('result', 'instalada', 'from', '0.2.1', 'to', 'no-es-version'));
reset role;
do $$
declare
  v jsonb := (select update_status from scale_connectors where id = '00000000-0000-0000-0000-000000000001');
begin
  if v ->> 'result' <> 'revertida' or v ->> 'to' <> '0.3.0' or length(v ->> 'message') <> 300 or v ? 'extra' then raise exception 'resultado mal guardado: %', v; end if;
  if (select update_status ->> 'to' from scale_connectors where id = '00000000-0000-0000-0000-000000000002') is not null then raise exception 'versión inválida guardada'; end if;
  if (select count(*) from audit_log where action = 'scale_connector.update') <> 1 then raise exception 'auditoría del resultado'; end if;
end $$;

-- 10. La empresa ve cómo le fue a SU PC; la otra empresa no.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2905', true);
do $$
begin
  if (select update_status ->> 'result' from scale_connectors where id = '00000000-0000-0000-0000-000000000001') <> 'revertida' then raise exception 'el dueño no ve el resultado'; end if;
  if exists (select 1 from scale_connectors where id = '00000000-0000-0000-0000-0000000f29c9') then raise exception 've la PC de otra empresa'; end if;
end $$;
select pg_temp.must_fail($$select secret_hash from scale_connectors limit 1$$, 'lee el hash del secreto');
reset role;

-- 11. Lista para el panel: cuántas PC la tienen y cuántas volvieron atrás.
update scale_connectors set version = '0.3.0' where id = '00000000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2906', true);
do $$
declare
  v jsonb := (select x from jsonb_array_elements(public.list_scale_connect_releases()) x where x ->> 'channel' = 'stable');
begin
  if (v ->> 'installed')::int <> 1 or (v ->> 'rolled_back')::int <> 1 or (v ->> 'active')::boolean is not true then raise exception 'lista: %', v; end if;
end $$;
reset role;

rollback;
