-- Pruebas de la migración 231 (lecturas del bloque "Versiones de Scale Connect" del panel de plataforma). Se deshace al final.
--   0. Permisos: anon no ejecuta nada; security definer + search_path fijo.
--   1. Un dueño de empresa (no administrador de plataforma) no puede LEER ni CAMBIAR nada de versiones ni canales.
--   2. El administrador ve cuántas PC tienen cada versión y cuántas fallaron o volvieron atrás.
--   3. El canal de la empresa y el manifiesto guardado (para "Pasar a estable").
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000f3101', 'Carnicería 231', 9961, 'estandar'),
  ('00000000-0000-0000-0000-0000000f3102', 'Otra 231', 9962, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f3111', '00000000-0000-0000-0000-0000000f3101', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f3121', 'duenio@231'),
  ('00000000-0000-0000-0000-0000000f3122', 'plataforma@231');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f3121', '00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3111', 'Dueño', 'owner');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000f3122');

-- 5 PC: 2 con la 9.0.1 (una en línea), 1 con la 9.0.0 que intentó la 9.0.1 y volvió atrás, 1 con la 9.0.0 que la
-- rechazó, 1 desvinculada con la 9.0.1 (no cuenta).
insert into scale_connectors (id, company_id, branch_id, name, secret_hash, version, last_seen_at, status, update_status) values
  ('00000000-0000-0000-0000-0000000f31c1', '00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3111', 'Caja 1',
   encode(sha256(convert_to('a', 'UTF8')), 'hex'), '9.0.1', now() - interval '20 seconds', 'active',
   '{"result":"instalada","from":"9.0.0","to":"9.0.1"}'),
  ('00000000-0000-0000-0000-0000000f31c2', '00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3111', 'Caja 2',
   encode(sha256(convert_to('b', 'UTF8')), 'hex'), '9.0.1', now() - interval '3 hours', 'active', null),
  ('00000000-0000-0000-0000-0000000f31c3', '00000000-0000-0000-0000-0000000f3102', null, 'Mostrador',
   encode(sha256(convert_to('c', 'UTF8')), 'hex'), '9.0.0', now() - interval '1 minute', 'active',
   '{"result":"revertida","from":"9.0.0","to":"9.0.1"}'),
  ('00000000-0000-0000-0000-0000000f31c4', '00000000-0000-0000-0000-0000000f3102', null, 'Depósito',
   encode(sha256(convert_to('d', 'UTF8')), 'hex'), '9.0.0', null, 'active',
   '{"result":"rechazada","from":"9.0.0","to":"9.0.1"}');
insert into scale_connectors (id, company_id, name, secret_hash, version, status, revoked_at) values
  ('00000000-0000-0000-0000-0000000f31c5', '00000000-0000-0000-0000-0000000f3102', 'Vieja',
   encode(sha256(convert_to('e', 'UTF8')), 'hex'), '9.0.1', 'revoked', now());

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
create function pg_temp.mf(p_version text, p_channel text) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema', 1, 'product', 'patagonia-scale-connect', 'version', p_version, 'channel', p_channel, 'minVersion', '0.1.0',
    'url', 'https://xyz.supabase.co/storage/v1/object/public/scale-connect/' || p_version || '/Setup.exe',
    'sha256', encode(sha256(convert_to(p_version, 'UTF8')), 'hex'), 'size', 41234567,
    'publishedAt', '2026-11-27T12:00:00.000Z', 'keyId', '0123456789abcdef', 'signature', repeat('A', 86) || '==')
$$;
grant execute on function pg_temp.mf(text, text) to authenticated;

-- 0. Permisos.
do $$
declare
  f text;
begin
  foreach f in array array['public.admin_scale_connect_versions()', 'public.admin_scale_connect_company_channel(uuid)',
                           'public.admin_scale_connect_release_manifest(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception 'anon ejecuta %', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'authenticated no ejecuta %', f; end if;
    if (select prosecdef from pg_proc where oid = f::regprocedure) is not true then raise exception '% no es security definer', f; end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and 'search_path=public' = any (proconfig)) then raise exception '% sin search_path fijo', f; end if;
  end loop;
  if not exists (select 1 from public.schema_migrations where version = '231_admin_scale_connect_versions') then raise exception 'falta schema_migrations'; end if;
end $$;

-- El administrador publica la 9.0.1 en piloto al 10 % (229).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3122', true);
select public.publish_scale_connect_release(pg_temp.mf('9.0.1', 'general'), 'pilot', 10);
reset role;

-- 1. El dueño no lee ni cambia nada.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3121', true);
select pg_temp.must_fail('select public.admin_scale_connect_versions()', 'dueño ve las versiones instaladas', '42501');
select pg_temp.must_fail($q$select public.admin_scale_connect_company_channel('00000000-0000-0000-0000-0000000f3101')$q$, 'dueño ve su canal', '42501');
select pg_temp.must_fail($q$select public.admin_scale_connect_release_manifest((select id from public.scale_connect_releases limit 1))$q$, 'dueño lee un manifiesto');
select pg_temp.must_fail($q$select public.admin_scale_connect_release_manifest('00000000-0000-0000-0000-000000000000')$q$, 'dueño lee un manifiesto (id)', '42501');
do $$ begin if public.list_scale_connect_releases() is not null then raise exception 'el dueño lista versiones'; end if; end $$;
select pg_temp.must_fail($q$select public.set_scale_connect_release('00000000-0000-0000-0000-000000000000', false)$q$, 'dueño frena', '42501');
select pg_temp.must_fail($q$select public.set_company_scale_connect_channel('00000000-0000-0000-0000-0000000f3101', 'pilot')$q$, 'dueño cambia su canal', '42501');
select pg_temp.must_fail($q$select public.publish_scale_connect_release(pg_temp.mf('9.0.2', 'general'), 'stable', 100)$q$, 'dueño publica', '42501');
-- Sin sesión tampoco.
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.must_fail('select public.admin_scale_connect_versions()', 'sin sesión ve las versiones', '42501');
reset role;
do $$
begin
  if (select count(*) from public.scale_connect_releases where version = '9.0.1' and active and rollout_percent = 10) <> 1 then
    raise exception 'el dueño cambió la versión'; end if;
  if (select scale_connect_channel from companies where id = '00000000-0000-0000-0000-0000000f3101') <> 'stable' then
    raise exception 'el dueño cambió su canal'; end if;
end $$;

-- 2 y 3. El administrador.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3122', true);
do $$
declare
  v jsonb := public.admin_scale_connect_versions();
  a jsonb;
  b jsonb;
  rel uuid;
  m jsonb;
begin
  select e into a from jsonb_array_elements(v) e where e ->> 'version' = '9.0.1';
  select e into b from jsonb_array_elements(v) e where e ->> 'version' = '9.0.0';
  if a is null or b is null then raise exception 'faltan versiones: %', v; end if;
  if (a ->> 'installed')::int <> 2 or (a ->> 'online')::int <> 1 then raise exception '9.0.1 instaladas: %', a; end if;
  if (a ->> 'failed')::int <> 1 or (a ->> 'rolled_back')::int <> 1 then raise exception '9.0.1 fallas: %', a; end if;
  if (b ->> 'installed')::int <> 2 or (b ->> 'failed')::int <> 0 or (b ->> 'rolled_back')::int <> 0 then raise exception '9.0.0: %', b; end if;
  if (v -> 0 ->> 'version') <> '9.0.1' then raise exception 'orden: %', v; end if;

  if public.admin_scale_connect_company_channel('00000000-0000-0000-0000-0000000f3101') <> 'stable' then raise exception 'canal inicial'; end if;
  perform public.set_company_scale_connect_channel('00000000-0000-0000-0000-0000000f3101', 'pilot');
  if public.admin_scale_connect_company_channel('00000000-0000-0000-0000-0000000f3101') <> 'pilot' then raise exception 'canal piloto'; end if;
  begin
    perform public.admin_scale_connect_company_channel('00000000-0000-0000-0000-0000000f3199');
    raise exception 'empresa inexistente tendría que fallar';
  exception when others then
    if sqlerrm not like 'Empresa inválida%' then raise; end if;
  end;

  -- "Pasar a estable": el mismo manifiesto, publicado en estable.
  select (e ->> 'id')::uuid into rel from jsonb_array_elements(public.list_scale_connect_releases()) e
   where e ->> 'version' = '9.0.1' and e ->> 'channel' = 'pilot';
  m := public.admin_scale_connect_release_manifest(rel);
  if m ->> 'version' <> '9.0.1' or m ->> 'signature' is null then raise exception 'manifiesto: %', m; end if;
  perform public.publish_scale_connect_release(m, 'stable', 0);
  if jsonb_array_length(public.list_scale_connect_releases()) <> 2 then raise exception 'no pasó a estable'; end if;
end $$;
reset role;

rollback;
