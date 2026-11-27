-- Pruebas de la migración 228 (Scale Connect: motor solo con envíos, con vencimiento y auditado; la cola respeta a qué
-- PC está vinculada cada balanza). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000f2801', 'Carnicería 228', 9941, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f2802', '00000000-0000-0000-0000-0000000f2801', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000f2805', 'duenio@228');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f2805', '00000000-0000-0000-0000-0000000f2801', '00000000-0000-0000-0000-0000000f2802', 'Dueño', 'owner');
insert into scale_profiles (company_id, branch_id, scale_key, brand, name, family) values
  ('00000000-0000-0000-0000-0000000f2801', '00000000-0000-0000-0000-0000000f2802', 'kretz-1', 'kretz', 'Report de la Caja 1', 'kretz'),
  ('00000000-0000-0000-0000-0000000f2801', '00000000-0000-0000-0000-0000000f2802', 'kretz-2', 'kretz', 'Report sin PC', 'kretz');
-- Dos PC del mismo local.
insert into scale_connectors (id, company_id, branch_id, name, secret_hash, version) values
  ('00000000-0000-0000-0000-0000000f28c1', '00000000-0000-0000-0000-0000000f2801', '00000000-0000-0000-0000-0000000f2802', 'Caja 1', encode(sha256(convert_to('s1', 'UTF8')), 'hex'), '0.2.0'),
  ('00000000-0000-0000-0000-0000000f28c2', '00000000-0000-0000-0000-0000000f2801', '00000000-0000-0000-0000-0000000f2802', 'Caja 2', encode(sha256(convert_to('s2', 'UTF8')), 'hex'), '0.2.0');

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

-- 0. Permisos (iguales que en la 226/227).
do $$
begin
  if has_function_privilege('authenticated', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'authenticated usa el motor'; end if;
  if has_function_privilege('anon', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'anon usa el motor'; end if;
  if not has_function_privilege('service_role', 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)', 'execute') then raise exception 'service_role sin motor'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_can_take(public.scale_connectors, public.scale_jobs)', 'execute') then raise exception 'authenticated usa can_take'; end if;
  if (select prosecdef from pg_proc where oid = 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)'::regprocedure) is not true then raise exception 'el motor dejó de ser security definer'; end if;
  if not exists (select 1 from pg_proc where oid = 'public.scale_connector_engine(uuid, text, uuid, text, jsonb)'::regprocedure and 'search_path=public' = any (proconfig)) then raise exception 'el motor sin search_path fijo'; end if;
  if not exists (select 1 from public.schema_migrations where version = '228_scale_connect_hardening') then raise exception 'falta schema_migrations'; end if;
end $$;

-- 1. Latidos: la Caja 2 "dice" que ve también la balanza de la Caja 1.
set local role service_role;
do $$
begin
  perform public.scale_connector_heartbeat('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), '0.2.0', '[{"key":"kretz-1"}]');
  perform public.scale_connector_heartbeat('00000000-0000-0000-0000-0000000f28c2', pg_temp.h('s2'), '0.2.0', '[{"key":"kretz-1"},{"key":"kretz-2"}]');
end $$;

-- 2. El dueño vincula kretz-1 a la Caja 1 y encola un envío a cada balanza, SIN elegir PC.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2805', true);
select public.bind_scale_to_connector('00000000-0000-0000-0000-0000000f2802', 'kretz-1', '00000000-0000-0000-0000-0000000f28c1', '{"id":"usb-1","kind":"serial","path":"COM3"}');
select set_config('test.j_k1', public.queue_scale_job('kretz-1', 'send', '{"products":[]}', null, null)::text, false);
select set_config('test.j_k2', public.queue_scale_job('kretz-2', 'send', '{"products":[]}', null, null)::text, false);
select set_config('request.jwt.claim.sub', '', true);

-- 3. La Caja 2 solo puede tomar el de la balanza sin PC; el de kretz-1 es de la Caja 1.
reset role;
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.scale_connector_claim_job('00000000-0000-0000-0000-0000000f28c2', pg_temp.h('s2'));
  if r is null or (r ->> 'id')::uuid <> current_setting('test.j_k2')::uuid then raise exception 'la Caja 2 tomó: %', r; end if;
  r := public.scale_connector_claim_job('00000000-0000-0000-0000-0000000f28c2', pg_temp.h('s2'));
  if r is not null then raise exception 'la Caja 2 se quedó con el envío de una balanza de la Caja 1: %', r; end if;
  if (public.scale_connector_heartbeat('00000000-0000-0000-0000-0000000f28c2', pg_temp.h('s2'), '0.2.0', '[{"key":"kretz-1"},{"key":"kretz-2"}]') ->> 'queued')::int <> 0 then
    raise exception 'el latido de la Caja 2 cuenta trabajos ajenos';
  end if;
  r := public.scale_connector_claim_job('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'));
  if r is null or (r ->> 'id')::uuid <> current_setting('test.j_k1')::uuid then raise exception 'la Caja 1 no tomó el suyo: %', r; end if;
end $$;

-- 4. Una prueba ("test") encolada por el dueño: el motor lee y reporta, pero NO escribe en su nombre.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2805', true);
select set_config('test.j_test', public.queue_scale_job('kretz-1', 'test', '{}', null, '00000000-0000-0000-0000-0000000f28c1')::text, false);
select set_config('request.jwt.claim.sub', '', true);
reset role;
set local role service_role;
do $$
declare r jsonb; j_test uuid := current_setting('test.j_test')::uuid; j_send uuid := current_setting('test.j_k1')::uuid;
begin
  r := public.scale_connector_claim_job('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'));
  if (r ->> 'id')::uuid <> j_test then raise exception 'no tomó la prueba: %', r; end if;

  r := public.scale_connector_engine('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_test, 'list_branch_scales');
  if jsonb_array_length(r -> 'scales') <> 2 then raise exception 'lectura con la prueba: %', r; end if;
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'save_branch_config', '{"config":{"prefixLength":2,"pluLength":5,"weightLength":5,"weightDivisor":1000,"totalLength":13}}')$q$,
    '00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_test), 'escribir con una prueba', 'P0001');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'set_scale_profile_active', '{"scale_key":"kretz-1","active":false}')$q$,
    '00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_test), 'apagar la balanza con una prueba', 'P0001');
  if exists (select 1 from branch_scale_configs where branch_id = '00000000-0000-0000-0000-0000000f2802') then raise exception 'la prueba escribió el formato'; end if;
  -- El reporte a soporte sí (es lo que se manda cuando la prueba falla).
  perform public.scale_connector_engine('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_test, 'report', '{"note":"no contesta","log_text":"{}"}');

  -- 5. Con el envío: escribe como el dueño y queda anotado que lo hizo la Caja 1.
  perform public.scale_connector_engine('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_send, 'save_branch_config',
    '{"config":{"prefixLength":2,"pluLength":5,"weightLength":5,"weightDivisor":1000,"totalLength":13,"payloadType":"weight"}}');
  if (select plu_length from branch_scale_configs where branch_id = '00000000-0000-0000-0000-0000000f2802') <> 5 then raise exception 'no guardó el formato con el envío'; end if;
  if coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' then raise exception 'quedó el usuario puesto después del motor'; end if;
  if not exists (
    select 1 from audit_log
    where action = 'scale_connector.engine' and entity_id = j_send::text and user_id = '00000000-0000-0000-0000-0000000f2805'
      and new_data ->> 'connector_id' = '00000000-0000-0000-0000-0000000f28c1' and new_data ->> 'action' = 'save_branch_config') then
    raise exception 'falta la auditoría de la PC';
  end if;
  if (select count(*) from audit_log where action = 'scale_connector.engine' and entity_id = j_test::text and new_data ->> 'action' = 'report') <> 1 then
    raise exception 'el reporte no quedó auditado';
  end if;
end $$;

-- 6. Vencimiento: un envío tomado hace más de 3 horas (aunque siga mandando avances) ya no usa el motor.
reset role;
update scale_jobs set claimed_at = now() - interval '3 hours 1 minute' where id = current_setting('test.j_k1')::uuid;
set local role service_role;
do $$
declare j_send uuid := current_setting('test.j_k1')::uuid;
begin
  perform public.scale_connector_job_progress('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_send, 1, 0, 0, 'sigo', '[]');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'save_branch_config', '{"config":{"prefixLength":2,"pluLength":4,"weightLength":5,"weightDivisor":1000,"totalLength":13}}')$q$,
    '00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_send), 'motor con un trabajo de más de 3 horas', 'P0001');
  perform pg_temp.must_fail(format($q$select public.scale_connector_engine(%L, %L, %L, 'list_branch_scales')$q$,
    '00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_send), 'lectura con un trabajo de más de 3 horas', 'P0001');
  if (select plu_length from branch_scale_configs where branch_id = '00000000-0000-0000-0000-0000000f2802') <> 5 then raise exception 'escribió con el trabajo vencido'; end if;
  -- Y el cierre sigue andando (el conector tiene que poder cerrarlo).
  perform public.scale_connector_finish_job('00000000-0000-0000-0000-0000000f28c1', pg_temp.h('s1'), j_send, 'failed', '{}', '[]', 'vencido');
end $$;

reset role;
rollback;
