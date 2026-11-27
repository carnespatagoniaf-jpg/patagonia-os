-- Pruebas de la migración 225 (Scale Connect: vinculación y cola de trabajos en la nube). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: dos locales (Centro y Norte). B: otra empresa.
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000e2001', 'Carnicería A', 9921, 'estandar'),
  ('00000000-0000-0000-0000-0000000e2011', 'Carnicería B', 9922, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000e2002', '00000000-0000-0000-0000-0000000e2001', 'Centro'),
  ('00000000-0000-0000-0000-0000000e2003', '00000000-0000-0000-0000-0000000e2001', 'Norte'),
  ('00000000-0000-0000-0000-0000000e2012', '00000000-0000-0000-0000-0000000e2011', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e2005', 'duenio@a'), ('00000000-0000-0000-0000-0000000e2006', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000e2007', 'contador@a'), ('00000000-0000-0000-0000-0000000e2008', 'lectura@a'),
  ('00000000-0000-0000-0000-0000000e2009', 'admin@a'), ('00000000-0000-0000-0000-0000000e2015', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000e2005', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000e2006', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000e2007', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Contador', 'accountant'),
  ('00000000-0000-0000-0000-0000000e2008', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Solo lectura', 'readonly'),
  ('00000000-0000-0000-0000-0000000e2009', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e2015', '00000000-0000-0000-0000-0000000e2011', '00000000-0000-0000-0000-0000000e2012', 'Dueño B', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000e200a', '00000000-0000-0000-0000-0000000e2001', '1', 'Nalga', 'kg', 10000, 18000),
  ('00000000-0000-0000-0000-0000000e201a', '00000000-0000-0000-0000-0000000e2011', '1', 'Nalga B', 'kg', 9000, 15000);
insert into scale_profiles (company_id, branch_id, scale_key, brand, name, family) values
  ('00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'kretz-1', 'kretz', 'Report mostrador', 'kretz'),
  ('00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2003', 'kretz-norte', 'kretz', 'Report Norte', 'kretz'),
  ('00000000-0000-0000-0000-0000000e2011', '00000000-0000-0000-0000-0000000e2012', 'kretz-1', 'kretz', 'Report de B', 'kretz');

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

-- 0. Permisos: lo del conector solo service_role; la web sin escrituras directas ni hashes a la vista.
do $$
begin
  if has_function_privilege('authenticated', 'public.scale_connector_redeem_pairing(text, text, text, text, text, text, uuid, boolean)', 'execute') then raise exception 'authenticated canjea códigos'; end if;
  if has_function_privilege('anon', 'public.scale_connector_redeem_pairing(text, text, text, text, text, text, uuid, boolean)', 'execute') then raise exception 'anon canjea códigos'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_heartbeat(uuid, text, text, jsonb)', 'execute') then raise exception 'authenticated late'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_claim_job(uuid, text)', 'execute') then raise exception 'authenticated toma trabajos'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_finish_job(uuid, text, uuid, text, jsonb, jsonb, text)', 'execute') then raise exception 'authenticated cierra trabajos'; end if;
  if has_function_privilege('authenticated', 'public.scale_connector_auth(uuid, text)', 'execute') then raise exception 'authenticated valida credenciales'; end if;
  if has_function_privilege('authenticated', 'public.scale_job_append_items(uuid, uuid, jsonb)', 'execute') then raise exception 'authenticated agrega productos'; end if;
  if not has_function_privilege('service_role', 'public.scale_connector_claim_job(uuid, text)', 'execute') then raise exception 'service_role no toma trabajos'; end if;
  if not has_function_privilege('authenticated', 'public.queue_scale_job(text, text, jsonb, uuid, uuid)', 'execute') then raise exception 'authenticated no encola'; end if;
  if has_function_privilege('anon', 'public.create_scale_connector_pairing(uuid)', 'execute') then raise exception 'anon pide códigos'; end if;
  if has_table_privilege('authenticated', 'public.scale_connectors', 'insert') or has_table_privilege('authenticated', 'public.scale_connectors', 'update')
     or has_table_privilege('authenticated', 'public.scale_connector_pairings', 'delete') then raise exception 'escritura directa abierta'; end if;
  if has_column_privilege('authenticated', 'public.scale_connectors', 'secret_hash', 'select') then raise exception 'se lee el hash del secreto'; end if;
  if has_column_privilege('authenticated', 'public.scale_connectors', 'fingerprint_hash', 'select') then raise exception 'se lee la huella'; end if;
  if has_column_privilege('authenticated', 'public.scale_connector_pairings', 'code_hash', 'select') then raise exception 'se lee el hash del código'; end if;
  if has_table_privilege('authenticated', 'public.scale_connector_pair_failures', 'select') then raise exception 'se leen los intentos'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_accountant_readonly' and tgrelid = 'public.scale_connectors'::regclass) then raise exception 'falta zz_accountant_readonly'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_accountant_readonly' and tgrelid = 'public.scale_connector_pairings'::regclass) then raise exception 'falta zz_accountant_readonly'; end if;
  if not exists (select 1 from public.schema_migrations where version = '225_scale_connect') then raise exception 'falta schema_migrations'; end if;
end $$;

-- 0b. El código: 8 caracteres sin 0/O/1/I.
do $$
declare c text;
begin
  for i in 1..300 loop
    c := public.scale_connect_new_code();
    if c !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$' then raise exception 'código con caracteres ambiguos: %', c; end if;
  end loop;
end $$;

set local role authenticated;

-- 1. Solo dueño o administrador piden códigos.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2006', true);
select pg_temp.must_fail($q$select public.create_scale_connector_pairing()$q$, 'cajera pide código');
select pg_temp.must_fail($q$select public.list_scale_connectors()$q$, 'cajera lista computadoras');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2008', true);
select pg_temp.must_fail($q$select public.create_scale_connector_pairing()$q$, 'solo lectura pide código');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2007', true);
select pg_temp.must_fail($q$select public.create_scale_connector_pairing()$q$, 'contador pide código');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
do $$
declare r jsonb;
begin
  perform pg_temp.must_fail($q$select public.create_scale_connector_pairing('00000000-0000-0000-0000-0000000e2012')$q$, 'sucursal de otra empresa');
  r := public.create_scale_connector_pairing();
  if (r ->> 'code') !~ '^[2-9A-HJ-NP-Z]{8}$' then raise exception 'código: %', r; end if;
  if (r ->> 'branch_id')::uuid <> '00000000-0000-0000-0000-0000000e2002' then raise exception 'sucursal por defecto'; end if;
  if (select count(*) from scale_connector_pairings where used_at is null and expires_at > now()) <> 1 then raise exception 'no se guardó el código'; end if;
  perform set_config('test.code1', r ->> 'code', false);
  -- Pedir otro anula el anterior.
  r := public.create_scale_connector_pairing();
  perform set_config('test.code_old', current_setting('test.code1'), false);
  perform set_config('test.code1', r ->> 'code', false);
  if (select count(*) from scale_connector_pairings where used_at is null and expires_at > now()) <> 1 then raise exception 'quedaron dos códigos vigentes'; end if;
end $$;
-- La admin pide uno para la otra PC.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2009', true);
select set_config('test.code2', public.create_scale_connector_pairing() ->> 'code', false);
-- El dueño de B, uno para su PC.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2015', true);
select set_config('test.codeB', public.create_scale_connector_pairing() ->> 'code', false);

-- 2. Canje (Edge Function = service_role).
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
declare r jsonb;
begin
  -- Código anulado, inventado o mal escrito: mismo error y queda anotado.
  r := public.scale_connector_redeem_pairing(current_setting('test.code_old'), 'Caja 1', pg_temp.h('pc-1'), pg_temp.h('s1'), '0.1.0', pg_temp.h('ip-1'));
  if r ->> 'error' <> 'codigo_invalido' then raise exception 'código anulado: %', r; end if;
  r := public.scale_connector_redeem_pairing('ZZZZZZZZ', 'Caja 1', pg_temp.h('pc-1'), pg_temp.h('s1'), '0.1.0', pg_temp.h('ip-1'));
  if r ->> 'error' <> 'codigo_invalido' then raise exception 'código inventado: %', r; end if;
  r := public.scale_connector_redeem_pairing('0O1I', 'Caja 1', pg_temp.h('pc-1'), pg_temp.h('s1'), '0.1.0', pg_temp.h('ip-1'));
  if r ->> 'error' <> 'codigo_invalido' then raise exception 'código ambiguo: %', r; end if;
  if (select count(*) from scale_connector_pair_failures where client_hash = pg_temp.h('ip-1')) <> 3 then raise exception 'no se anotaron los intentos'; end if;
  perform pg_temp.must_fail(format($q$select public.scale_connector_redeem_pairing(%L, 'x', null, 'no-es-hash', null, %L)$q$, current_setting('test.code1'), pg_temp.h('ip-1')), 'secreto sin hash');

  -- Bueno (con guion y en minúsculas, como lo escribe la gente).
  r := public.scale_connector_redeem_pairing(lower(substr(current_setting('test.code1'), 1, 4) || '-' || substr(current_setting('test.code1'), 5)),
         '  Caja   1 ', pg_temp.h('pc-1'), pg_temp.h('s1'), '0.1.0', pg_temp.h('ip-1'));
  if not (r ->> 'ok')::boolean or r ->> 'name' <> 'Caja 1' or (r ->> 'recovered')::boolean then raise exception 'canje: %', r; end if;
  perform set_config('test.conn1', r ->> 'connector_id', false);
  if (select secret_hash from scale_connectors where id = (r ->> 'connector_id')::uuid) <> pg_temp.h('s1') then raise exception 'hash del secreto'; end if;
  if (select branch_id from scale_connectors where id = (r ->> 'connector_id')::uuid) <> '00000000-0000-0000-0000-0000000e2002' then raise exception 'sucursal'; end if;
  if (select count(*) from audit_log where entity_id = r ->> 'connector_id' and action = 'scale_connector.pair') <> 1 then raise exception 'auditoría del canje'; end if;

  -- De un solo uso.
  r := public.scale_connector_redeem_pairing(current_setting('test.code1'), 'Caja 9', pg_temp.h('pc-9'), pg_temp.h('s9'), '0.1.0', pg_temp.h('ip-2'));
  if r ->> 'error' <> 'codigo_invalido' then raise exception 'código usado dos veces: %', r; end if;

  -- Nombre repetido en la empresa.
  r := public.scale_connector_redeem_pairing(current_setting('test.code2'), 'caja 1', pg_temp.h('pc-2'), pg_temp.h('s2'), '0.1.0', pg_temp.h('ip-2'));
  if r ->> 'error' <> 'nombre_repetido' then raise exception 'nombre repetido: %', r; end if;
  r := public.scale_connector_redeem_pairing(current_setting('test.code2'), 'Caja 2', pg_temp.h('pc-2'), pg_temp.h('s2'), '0.1.0', pg_temp.h('ip-2'));
  if not (r ->> 'ok')::boolean then raise exception 'canje 2: %', r; end if;
  perform set_config('test.conn2', r ->> 'connector_id', false);

  r := public.scale_connector_redeem_pairing(current_setting('test.codeB'), 'Caja 1', pg_temp.h('pc-b'), pg_temp.h('sb'), '0.1.0', pg_temp.h('ip-b'));
  if not (r ->> 'ok')::boolean then raise exception 'canje B: %', r; end if;
  perform set_config('test.connB', r ->> 'connector_id', false);
end $$;

-- 3. Código vencido.
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
set local role authenticated;
select set_config('test.code3', public.create_scale_connector_pairing() ->> 'code', false);
reset role;
update scale_connector_pairings set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
 where used_at is null and company_id = '00000000-0000-0000-0000-0000000e2001';
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.scale_connector_redeem_pairing(current_setting('test.code3'), 'Caja 3', pg_temp.h('pc-3'), pg_temp.h('s3'), '0.1.0', pg_temp.h('ip-3'));
  if r ->> 'error' <> 'codigo_invalido' then raise exception 'código vencido: %', r; end if;
end $$;

-- 4. Fuerza bruta: 10 fallidos desde la misma IP frenan incluso un código bueno.
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
set local role authenticated;
select set_config('test.code4', public.create_scale_connector_pairing() ->> 'code', false);
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
declare r jsonb;
begin
  for i in 1..10 loop
    perform public.scale_connector_redeem_pairing('ZZZZZZZZ', 'x', null, pg_temp.h('x'), null, pg_temp.h('ip-malo'));
  end loop;
  r := public.scale_connector_redeem_pairing(current_setting('test.code4'), 'Caja 4', pg_temp.h('pc-4'), pg_temp.h('s4'), '0.1.0', pg_temp.h('ip-malo'));
  if r ->> 'error' <> 'demasiados_intentos' then raise exception 'sin freno: %', r; end if;

  -- 5. Reinstalación: misma huella → "¿Es Caja 1?" sin gastar el código.
  r := public.scale_connector_redeem_pairing(current_setting('test.code4'), 'Caja nueva', pg_temp.h('pc-1'), pg_temp.h('s1b'), '0.2.0', pg_temp.h('ip-1'));
  if r ->> 'error' <> 'elegir' or jsonb_array_length(r -> 'candidates') <> 1
     or (r -> 'candidates' -> 0 ->> 'id') <> current_setting('test.conn1') or (r -> 'candidates' -> 0 ->> 'name') <> 'Caja 1' then
    raise exception 'no ofreció recuperar: %', r;
  end if;
  -- No se puede "recuperar" otra PC con una huella distinta.
  r := public.scale_connector_redeem_pairing(current_setting('test.code4'), '', pg_temp.h('pc-1'), pg_temp.h('s1b'), '0.2.0', pg_temp.h('ip-1'), current_setting('test.conn2')::uuid);
  if r ->> 'error' <> 'no_se_puede_recuperar' then raise exception 'recuperó otra PC: %', r; end if;
  -- Ni una de otra empresa.
  r := public.scale_connector_redeem_pairing(current_setting('test.code4'), '', pg_temp.h('pc-b'), pg_temp.h('s1b'), '0.2.0', pg_temp.h('ip-1'), current_setting('test.connB')::uuid);
  if r ->> 'error' <> 'no_se_puede_recuperar' then raise exception 'recuperó una PC de B: %', r; end if;
  r := public.scale_connector_redeem_pairing(current_setting('test.code4'), '', pg_temp.h('pc-1'), pg_temp.h('s1b'), '0.2.0', pg_temp.h('ip-1'), current_setting('test.conn1')::uuid);
  if not (r ->> 'ok')::boolean or not (r ->> 'recovered')::boolean or r ->> 'connector_id' <> current_setting('test.conn1') or r ->> 'name' <> 'Caja 1' then
    raise exception 'recuperar: %', r;
  end if;
  if (select version from scale_connectors where id = current_setting('test.conn1')::uuid) <> '0.2.0' then raise exception 'versión al recuperar'; end if;
  -- El secreto viejo ya no sirve; el nuevo sí.
  perform pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L)$q$, current_setting('test.conn1'), pg_temp.h('s1')), 'secreto viejo', 'PT401');
  perform public.scale_connector_heartbeat(current_setting('test.conn1')::uuid, pg_temp.h('s1b'));
end $$;

-- 6. Credencial: secreto incorrecto, de otra PC o inventada.
do $$
begin
  perform pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L)$q$, current_setting('test.conn1'), pg_temp.h('otro')), 'secreto incorrecto', 'PT401');
  perform pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L)$q$, current_setting('test.conn1'), pg_temp.h('s2')), 'secreto de otra PC', 'PT401');
  perform pg_temp.must_fail(format($q$select public.scale_connector_claim_job(%L, %L)$q$, gen_random_uuid(), pg_temp.h('s1b')), 'conector inventado', 'PT401');
  perform pg_temp.must_fail(format($q$select public.scale_connector_config(%L, 'abc')$q$, current_setting('test.conn1')), 'secreto sin formato', 'PT401');
end $$;

-- 7. Latidos: las dos PC de A ven kretz-1; B también tiene una kretz-1 (no se mezclan).
do $$
declare r jsonb;
begin
  r := public.scale_connector_heartbeat(current_setting('test.conn1')::uuid, pg_temp.h('s1b'), '0.2.1',
         '[{"key":"kretz-1","name":"Report","online":true},{"key":""},{"nada":1},"texto"]');
  if (r ->> 'queued')::int <> 0 then raise exception 'cola vacía: %', r; end if;
  if (select jsonb_array_length(seen_scales) from scale_connectors where id = current_setting('test.conn1')::uuid) <> 1 then raise exception 'balanzas vistas sin limpiar'; end if;
  if (select last_seen_at from scale_connectors where id = current_setting('test.conn1')::uuid) is null then raise exception 'latido'; end if;
  perform public.scale_connector_heartbeat(current_setting('test.conn2')::uuid, pg_temp.h('s2'), '0.1.0', '[{"key":"kretz-1"}]');
  perform public.scale_connector_heartbeat(current_setting('test.connB')::uuid, pg_temp.h('sb'), '0.1.0', '[{"key":"kretz-1"}]');
  perform pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L, null, %L)$q$, current_setting('test.conn1'), pg_temp.h('s1b'),
    (select jsonb_agg(jsonb_build_object('key', 'k' || g)) from generate_series(1, 51) g)), 'más de 50 balanzas');

  -- Configuración: solo las balanzas de SU sucursal y de SU empresa.
  r := public.scale_connector_config(current_setting('test.conn1')::uuid, pg_temp.h('s1b'));
  if jsonb_array_length(r -> 'scales') <> 1 or (r -> 'scales' -> 0 ->> 'name') <> 'Report mostrador' or r ->> 'company_name' <> 'Carnicería A' then
    raise exception 'config: %', r;
  end if;
  r := public.scale_connector_config(current_setting('test.connB')::uuid, pg_temp.h('sb'));
  if jsonb_array_length(r -> 'scales') <> 1 or (r -> 'scales' -> 0 ->> 'name') <> 'Report de B' then raise exception 'config B: %', r; end if;
end $$;

-- 8. Encolar desde la web: roles, empresa, productos.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2008', true);
select pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{}')$q$, 'solo lectura encola');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2007', true);
select pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{}')$q$, 'contador encola');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2006', true);
do $$
declare v uuid;
begin
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{"products":[{"product_id":"00000000-0000-0000-0000-0000000e201a","plu":"1"}]}')$q$, 'producto de B');
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{}', '00000000-0000-0000-0000-0000000e2003')$q$, 'cajera en otro local');
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{}', '00000000-0000-0000-0000-0000000e2012')$q$, 'sucursal de B');
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'borrar', '{}')$q$, 'tipo inválido');
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '[]')$q$, 'payload que no es objeto');
  perform pg_temp.must_fail($q$select public.queue_scale_job('kretz-1', 'send', '{"products":{}}')$q$, 'products que no es lista');
  perform pg_temp.must_fail(format($q$select public.queue_scale_job('kretz-1', 'send', '{}', null, %L)$q$, current_setting('test.connB')), 'conector de B');
  v := public.queue_scale_job('kretz-1', 'send', '{"products":[{"product_id":"00000000-0000-0000-0000-0000000e200a","plu":"1","name":"Nalga","price":18000},{"plu":"2","name":"Vacío","price":15000}]}');
  if (select status || '|' || source || '|' || requested_count from scale_jobs where id = v) <> 'queued|connector|2' then raise exception 'trabajo en cola'; end if;
  if (select finished_at from scale_jobs where id = v) is not null then raise exception 'en cola con fin'; end if;
  perform set_config('test.job1', v::text, false);
  if (select count(*) from audit_log where entity_id = v::text and action = 'scale_job.queue') <> 1 then raise exception 'auditoría de la cola'; end if;
end $$;

-- 9. Tomar trabajos: lo toma UNO solo; B nunca ve los de A.
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
declare r jsonb; r2 jsonb;
begin
  if (public.scale_connector_heartbeat(current_setting('test.conn2')::uuid, pg_temp.h('s2'), null, '[{"key":"kretz-1"}]') ->> 'queued')::int <> 1 then raise exception 'latido sin la cola'; end if;
  r := public.scale_connector_claim_job(current_setting('test.connB')::uuid, pg_temp.h('sb'));
  if r is not null then raise exception 'B tomó un trabajo de A: %', r; end if;
  r := public.scale_connector_claim_job(current_setting('test.conn1')::uuid, pg_temp.h('s1b'));
  if r ->> 'id' <> current_setting('test.job1') or jsonb_array_length(r -> 'payload' -> 'products') <> 2 or r ->> 'scale_key' <> 'kretz-1' then raise exception 'tomar: %', r; end if;
  r2 := public.scale_connector_claim_job(current_setting('test.conn2')::uuid, pg_temp.h('s2'));
  if r2 is not null then raise exception 'dos conectores tomaron el mismo: %', r2; end if;
  if (select status || '|' || connector_id from scale_jobs where id = current_setting('test.job1')::uuid) <> 'running|' || current_setting('test.conn1') then raise exception 'quedó tomado'; end if;

  -- Avance con productos; el reintento con la misma secuencia no duplica.
  r := public.scale_connector_job_progress(current_setting('test.conn1')::uuid, pg_temp.h('s1b'), current_setting('test.job1')::uuid, 1, 1, 2, 'Nalga',
         '[{"product_id":"00000000-0000-0000-0000-0000000e200a","plu":"1","action":"write","status":"confirmed","sent":{"name":"Nalga","price":18000}}]');
  r := public.scale_connector_job_progress(current_setting('test.conn1')::uuid, pg_temp.h('s1b'), current_setting('test.job1')::uuid, 1, 1, 2, 'Nalga',
         '[{"product_id":"00000000-0000-0000-0000-0000000e200a","plu":"1","action":"write","status":"confirmed"}]');
  if not (r ->> 'duplicate')::boolean then raise exception 'reintento no detectado'; end if;
  if (select count(*) from scale_job_items where job_id = current_setting('test.job1')::uuid) <> 1 then raise exception 'productos duplicados'; end if;
  if (select progress ->> 'done' from scale_jobs where id = current_setting('test.job1')::uuid) <> '1' then raise exception 'avance'; end if;

  -- Otra PC (de A o de B) no puede informar ni cerrar un trabajo ajeno.
  perform pg_temp.must_fail(format($q$select public.scale_connector_job_progress(%L, %L, %L, 2)$q$, current_setting('test.conn2'), pg_temp.h('s2'), current_setting('test.job1')), 'otra PC informa', 'PT404');
  perform pg_temp.must_fail(format($q$select public.scale_connector_finish_job(%L, %L, %L, 'done')$q$, current_setting('test.connB'), pg_temp.h('sb'), current_setting('test.job1')), 'B cierra', 'PT404');
  -- Producto de B en el resultado: no.
  perform pg_temp.must_fail(format($q$select public.scale_connector_finish_job(%L, %L, %L, 'done', '{}', '[{"product_id":"00000000-0000-0000-0000-0000000e201a","action":"write","status":"confirmed"}]')$q$,
    current_setting('test.conn1'), pg_temp.h('s1b'), current_setting('test.job1')), 'producto de B en el resultado');

  r := public.scale_connector_finish_job(current_setting('test.conn1')::uuid, pg_temp.h('s1b'), current_setting('test.job1')::uuid, 'partial', '{}',
         '[{"plu":"2","action":"write","status":"failed","reason":"la balanza no contestó"}]', 'no_contesta');
  if (r ->> 'confirmed')::int <> 1 or (r ->> 'failed')::int <> 1 or (r ->> 'requested')::int <> 2 then raise exception 'cierre: %', r; end if;
  if (select status || '|' || error_code || '|' || app_version from scale_jobs where id = current_setting('test.job1')::uuid) <> 'partial|no_contesta|0.2.1' then raise exception 'estado final'; end if;
  perform pg_temp.must_fail(format($q$select public.scale_connector_finish_job(%L, %L, %L, 'done')$q$, current_setting('test.conn1'), pg_temp.h('s1b'), current_setting('test.job1')), 'cerrar dos veces', 'PT409');
  perform pg_temp.must_fail(format($q$select public.scale_connector_job_progress(%L, %L, %L, 5)$q$, current_setting('test.conn1'), pg_temp.h('s1b'), current_setting('test.job1')), 'avance de cerrado', 'PT409');
end $$;

-- 10. Trabajo dirigido a una PC: solo esa lo toma. Y un trabajo para una balanza que nadie ve queda en cola.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
select set_config('test.job2', public.queue_scale_job('kretz-1', 'test', '{}', null, current_setting('test.conn2')::uuid)::text, false);
select set_config('test.job3', public.queue_scale_job('systel-x', 'read', '{}')::text, false);
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.scale_connector_claim_job(current_setting('test.conn1')::uuid, pg_temp.h('s1b'));
  if r is not null then raise exception 'conn1 tomó uno ajeno: %', r; end if;
  r := public.scale_connector_claim_job(current_setting('test.conn2')::uuid, pg_temp.h('s2'));
  if r ->> 'id' <> current_setting('test.job2') then raise exception 'conn2 no tomó el suyo: %', r; end if;
  if public.scale_connector_claim_job(current_setting('test.conn2')::uuid, pg_temp.h('s2')) is not null then raise exception 'systel-x no la ve nadie'; end if;
  if (select status from scale_jobs where id = current_setting('test.job3')::uuid) <> 'queued' then raise exception 'job3 tendría que seguir en cola'; end if;
end $$;

-- 11. Límite de pedidos por minuto.
reset role;
update scale_connectors set api_calls = 240, api_window_at = now() where id = current_setting('test.conn2')::uuid;
set local role service_role;
select pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L)$q$, current_setting('test.conn2'), pg_temp.h('s2')), 'más de 240 por minuto', 'PT429');
reset role;
update scale_connectors set api_calls = 0 where id = current_setting('test.conn2')::uuid;

-- 12. La web: listar, renombrar, revocar. Lectura por RLS solo de la propia empresa.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2015', true);
do $$
begin
  if jsonb_array_length(public.list_scale_connectors()) <> 1 then raise exception 'B ve computadoras de A'; end if;
  if (select count(*) from scale_connectors where company_id = '00000000-0000-0000-0000-0000000e2001') <> 0 then raise exception 'RLS: B lee las de A'; end if;
  if (select count(*) from scale_jobs where company_id = '00000000-0000-0000-0000-0000000e2001') <> 0 then raise exception 'RLS: B lee trabajos de A'; end if;
  perform pg_temp.must_fail(format($q$select public.revoke_scale_connector(%L)$q$, current_setting('test.conn1')), 'B revoca una de A');
  perform pg_temp.must_fail(format($q$select public.rename_scale_connector(%L, 'Hackeada')$q$, current_setting('test.conn1')), 'B renombra una de A');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2006', true);
do $$
begin
  perform pg_temp.must_fail(format($q$select public.revoke_scale_connector(%L)$q$, current_setting('test.conn2')), 'cajera revoca');
  if (select count(*) from scale_connectors) <> 2 then raise exception 'la cajera no ve las de su empresa'; end if;
  perform pg_temp.must_fail($q$select secret_hash from scale_connectors$q$, 'leer el hash del secreto');
  perform pg_temp.must_fail($q$select code_hash from scale_connector_pairings$q$, 'leer el hash del código');
  perform pg_temp.must_fail($q$update scale_connectors set status = 'active'$q$, 'update directo');
  perform pg_temp.must_fail($q$delete from scale_connector_pairings$q$, 'delete directo');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
do $$
declare l jsonb;
begin
  perform public.rename_scale_connector(current_setting('test.conn2')::uuid, 'Caja depósito');
  perform pg_temp.must_fail(format($q$select public.rename_scale_connector(%L, '')$q$, current_setting('test.conn2')), 'nombre vacío');
  l := public.list_scale_connectors();
  if jsonb_array_length(l) <> 2 then raise exception 'lista: %', l; end if;
  if l::text like '%secret%' or l::text like '%fingerprint%' then raise exception 'la lista muestra hashes'; end if;
  if not exists (select 1 from jsonb_array_elements(l) e(x) where e.x ->> 'name' = 'Caja depósito' and (e.x ->> 'online')::boolean) then raise exception 'en línea: %', l; end if;

  -- Un trabajo en cola para conn2, y se revoca: queda fallido.
  perform set_config('test.job4', public.queue_scale_job('kretz-1', 'send', '{}', null, current_setting('test.conn2')::uuid)::text, false);
  perform public.revoke_scale_connector(current_setting('test.conn2')::uuid);
  perform public.revoke_scale_connector(current_setting('test.conn2')::uuid); -- dos veces no rompe
  if (select status || '|' || error_code from scale_jobs where id = current_setting('test.job4')::uuid) <> 'failed|conector_revocado' then raise exception 'trabajo del revocado'; end if;
  if (select status || '|' || error_code from scale_jobs where id = current_setting('test.job2')::uuid) <> 'failed|conector_revocado' then raise exception 'trabajo en curso del revocado'; end if;
  if (select (e.x ->> 'online')::boolean from jsonb_array_elements(public.list_scale_connectors()) e(x) where e.x ->> 'id' = current_setting('test.conn2')) then raise exception 'revocada figura en línea'; end if;
  perform pg_temp.must_fail(format($q$select public.queue_scale_job('kretz-1', 'send', '{}', null, %L)$q$, current_setting('test.conn2')), 'encolar a una revocada');
  perform pg_temp.must_fail(format($q$select public.rename_scale_connector(%L, 'Otra')$q$, current_setting('test.conn2')), 'renombrar revocada');
end $$;

-- 13. El revocado no puede nada, aunque alguien le vuelva a poner "active" a mano: su secreto ya no coincide.
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$
begin
  perform pg_temp.must_fail(format($q$select public.scale_connector_heartbeat(%L, %L)$q$, current_setting('test.conn2'), pg_temp.h('s2')), 'revocado late', 'PT401');
  perform pg_temp.must_fail(format($q$select public.scale_connector_claim_job(%L, %L)$q$, current_setting('test.conn2'), pg_temp.h('s2')), 'revocado toma', 'PT401');
end $$;
reset role;
update scale_connectors set status = 'active', revoked_at = null where id = current_setting('test.conn2')::uuid;
set local role service_role;
select pg_temp.must_fail(format($q$select public.scale_connector_config(%L, %L)$q$, current_setting('test.conn2'), pg_temp.h('s2')), 'revocado reactivado a mano', 'PT401');
reset role;
update scale_connectors set status = 'revoked', revoked_at = now(), secret_hash = pg_temp.h('s2') where id = current_setting('test.conn2')::uuid;
set local role service_role;
select pg_temp.must_fail(format($q$select public.scale_connector_config(%L, %L)$q$, current_setting('test.conn2'), pg_temp.h('s2')), 'revocado con su secreto', 'PT403');

-- 14. Vencidos: en cola más de un día, o tomado sin avance hace más de 30 minutos.
reset role;
update scale_jobs set started_at = now() - interval '2 days' where id = current_setting('test.job3')::uuid;
set local role service_role;
do $$
begin
  perform public.scale_connector_claim_job(current_setting('test.conn1')::uuid, pg_temp.h('s1b'));
  if (select status || '|' || error_code from scale_jobs where id = current_setting('test.job3')::uuid) <> 'failed|vencido' then raise exception 'no venció'; end if;
end $$;

reset role;
rollback;
