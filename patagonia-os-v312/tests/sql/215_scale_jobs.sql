-- Pruebas de la migración 215 (historial de envíos a las balanzas). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: dos locales (Centro y Norte). B: otra empresa.
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000d1001', 'Carnicería A', 9911, 'estandar'),
  ('00000000-0000-0000-0000-0000000d1011', 'Carnicería B', 9912, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d1002', '00000000-0000-0000-0000-0000000d1001', 'Centro'),
  ('00000000-0000-0000-0000-0000000d1003', '00000000-0000-0000-0000-0000000d1001', 'Norte'),
  ('00000000-0000-0000-0000-0000000d1012', '00000000-0000-0000-0000-0000000d1011', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d1005', 'duenio@a'), ('00000000-0000-0000-0000-0000000d1006', 'cajera-centro@a'),
  ('00000000-0000-0000-0000-0000000d1007', 'contador@a'), ('00000000-0000-0000-0000-0000000d1008', 'lectura-centro@a'),
  ('00000000-0000-0000-0000-0000000d1015', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000d1005', '00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d1002', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000d1006', '00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d1002', 'Cajera Centro', 'cashier'),
  ('00000000-0000-0000-0000-0000000d1007', '00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d1002', 'Contador', 'accountant'),
  ('00000000-0000-0000-0000-0000000d1008', '00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d1002', 'Solo lectura', 'readonly'),
  ('00000000-0000-0000-0000-0000000d1015', '00000000-0000-0000-0000-0000000d1011', '00000000-0000-0000-0000-0000000d1012', 'Dueño B', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000d100a', '00000000-0000-0000-0000-0000000d1001', '1', 'Nalga', 'kg', 10000, 18000),
  ('00000000-0000-0000-0000-0000000d100b', '00000000-0000-0000-0000-0000000d1001', '2', 'Vacío', 'kg', 9000, 15000),
  ('00000000-0000-0000-0000-0000000d101a', '00000000-0000-0000-0000-0000000d1011', '1', 'Nalga B', 'kg', 9000, 15000);

create function pg_temp.must_fail(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

-- Las funciones nuevas: security definer, sin EXECUTE para anon ni PUBLIC.
do $$
begin
  if has_function_privilege('anon', 'public.start_scale_job(uuid, text, text, text, integer, text, jsonb)', 'execute') then raise exception 'anon puede start_scale_job'; end if;
  if has_function_privilege('anon', 'public.finish_scale_job(uuid, text, jsonb, jsonb, text)', 'execute') then raise exception 'anon puede finish_scale_job'; end if;
  if not has_function_privilege('authenticated', 'public.start_scale_job(uuid, text, text, text, integer, text, jsonb)', 'execute') then raise exception 'authenticated no puede start_scale_job'; end if;
  if has_table_privilege('authenticated', 'public.scale_jobs', 'insert') or has_table_privilege('authenticated', 'public.scale_job_items', 'delete') then raise exception 'escritura directa abierta'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_accountant_readonly' and tgrelid = 'public.scale_jobs'::regclass) then raise exception 'falta zz_accountant_readonly en scale_jobs'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_accountant_readonly' and tgrelid = 'public.scale_job_items'::regclass) then raise exception 'falta zz_accountant_readonly en scale_job_items'; end if;
  if not exists (select 1 from public.schema_migrations where version = '215_scale_jobs') then raise exception 'falta el registro en schema_migrations'; end if;
end $$;

set local role authenticated;

-- 1. La cajera del Centro manda productos: 2 confirmados, 1 falló, 1 salteado.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1006', true);
do $$
declare v uuid; r jsonb;
begin
  v := public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'kretz-report-1', 'send', 'web', 3, 'web-abc123', '{"modelo":"Kretz Report"}');
  perform set_config('test.job1', v::text, false);
  if (select status from scale_jobs where id = v) <> 'running' then raise exception 'no quedó en curso'; end if;
  if (select created_by from scale_jobs where id = v) <> '00000000-0000-0000-0000-0000000d1006' then raise exception 'quién'; end if;

  r := public.finish_scale_job(v, 'partial', '{"requested":3,"confirmed":2}',
    '[{"product_id":"00000000-0000-0000-0000-0000000d100a","plu":"1","action":"write","status":"failed","reason":"la balanza no contestó al grabarlo","sent":{"name":"Nalga","price":18000}},
      {"plu":"7","action":"write","status":"skipped","reason":"sin precio"},
      {"plu":"9","action":"replace","status":"pending","reason":"ocupado_en_balanza: en la balanza el 9 es \"POLLO\""}]', 'frenado');
  if (r ->> 'items')::int <> 3 or (r ->> 'confirmed')::int <> 2 or (r ->> 'failed')::int <> 1 or (r ->> 'skipped')::int <> 1 then raise exception 'contadores: %', r; end if;
  if (select status || '|' || error_code from scale_jobs where id = v) <> 'partial|frenado' then raise exception 'estado final'; end if;
  if (select finished_at from scale_jobs where id = v) is null then raise exception 'sin fin'; end if;
  if (select count(*) from scale_job_items where job_id = v) <> 3 then raise exception 'productos'; end if;
  if (select sent ->> 'price' from scale_job_items where job_id = v and plu = '1') <> '18000' then raise exception 'lo enviado'; end if;
  if (select count(*) from audit_log where entity_id = v::text and action in ('scale_job.start', 'scale_job.finish')) <> 2 then raise exception 'auditoría'; end if;

  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[]', null)$q$, v), 'cerrar dos veces');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1003', 'k', 'send')$q$, 'cajera en otro local');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1012', 'k', 'send')$q$, 'sucursal de otra empresa');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'k', 'borrar')$q$, 'tipo inválido');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'k', 'send', 'celular')$q$, 'origen inválido');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', '', 'send')$q$, 'sin balanza');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'k', 'send', 'web', 10001)$q$, 'más de 10.000');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'k', 'send', 'web', 1, null, '[]')$q$, 'detalle que no es objeto');
end $$;

-- 2. Datos inválidos en los productos: no se cierra nada.
do $$
declare v uuid := public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'systel-a', 'send');
begin
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'running', '{}', '[]', null)$q$, v), 'estado running');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[{"action":"write","status":"ok"}]', null)$q$, v), 'estado de producto inválido');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[{"action":"borrar_todo","status":"confirmed"}]', null)$q$, v), 'acción inválida');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[{"product_id":"00000000-0000-0000-0000-0000000d101a","action":"write","status":"confirmed"}]', null)$q$, v), 'producto de otra empresa');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[{"product_id":"x","action":"write","status":"confirmed"}]', null)$q$, v), 'product_id que no es uuid');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[{"action":"write","status":"confirmed","sent":[1]}]', null)$q$, v), 'sent que no es objeto');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', %L, null)$q$, v,
    (select jsonb_agg(jsonb_build_object('action', 'write', 'status', 'confirmed', 'plu', g::text)) from generate_series(1, 10001) g)), 'más de 10.000 productos');
  if (select status from scale_jobs where id = v) <> 'running' then raise exception 'quedó cerrado con datos inválidos'; end if;
  -- 10.000 justos sí; sin contadores, salen de contar los productos.
  perform public.finish_scale_job(v, 'done', null, (select jsonb_agg(jsonb_build_object('action', 'write', 'status', 'confirmed', 'plu', g::text)) from generate_series(1, 10000) g), null);
  if (select confirmed_count from scale_jobs where id = v) <> 10000 then raise exception 'contados de los productos'; end if;
end $$;

-- 3. Solo lectura llega a "Mis balanzas" y puede registrar; el contador no.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1008', true);
do $$
begin
  perform public.finish_scale_job(public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'kretz-aura', 'test'), 'failed', '{}', '[]', 'no_contesta');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1007', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000d1002', 'k', 'send')$q$, 'contador');
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[]', null)$q$, current_setting('test.job1')), 'contador cierra');
end $$;

-- 4. La otra empresa no ve ni cierra lo de A.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1015', true);
do $$
begin
  if (select count(*) from scale_jobs) <> 0 or (select count(*) from scale_job_items) <> 0 then raise exception 'B ve el historial de A'; end if;
  perform pg_temp.must_fail(format($q$select public.finish_scale_job(%L, 'done', '{}', '[]', null)$q$, current_setting('test.job1')), 'B cierra un envío de A');
end $$;

-- 5. El dueño de A ve todo lo de su empresa, y nadie escribe las tablas directo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1005', true);
do $$
begin
  if (select count(*) from scale_jobs) <> 3 then raise exception 'el dueño no ve los 3 envíos'; end if;
  if (select count(*) from scale_job_items) <> 10003 then raise exception 'el dueño no ve los productos'; end if;
  perform pg_temp.must_fail($q$insert into scale_jobs (company_id, branch_id, scale_key, kind) values ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000d1002', 'k', 'send')$q$, 'insert directo');
  perform pg_temp.must_fail($q$update scale_jobs set status = 'done'$q$, 'update directo');
  perform pg_temp.must_fail($q$delete from scale_job_items$q$, 'delete directo');
end $$;

reset role;
rollback;
