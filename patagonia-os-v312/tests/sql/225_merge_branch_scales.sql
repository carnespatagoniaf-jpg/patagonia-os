-- Pruebas de la migración 225 (unir registros repetidos de la misma balanza). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- Empresa A, sucursal Centro: la misma Systel registrada 3 veces ({"address":20}), una Kretz suelta y dos Systel que
-- imprimen distinto (address 30). Empresa B aparte.
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000e2501', 'Carnicería A', 9951, 'estandar'),
  ('00000000-0000-0000-0000-0000000e2511', 'Carnicería B', 9952, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000e2502', '00000000-0000-0000-0000-0000000e2501', 'Centro'),
  ('00000000-0000-0000-0000-0000000e2512', '00000000-0000-0000-0000-0000000e2511', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e2505', 'duenio@a'), ('00000000-0000-0000-0000-0000000e2506', 'admin@a'),
  ('00000000-0000-0000-0000-0000000e2507', 'encargado@a'), ('00000000-0000-0000-0000-0000000e2508', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000e2515', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000e2505', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'Dueño', 'owner', true),
  ('00000000-0000-0000-0000-0000000e2506', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'Admin', 'admin', true),
  ('00000000-0000-0000-0000-0000000e2507', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'Encargado', 'manager', true),
  ('00000000-0000-0000-0000-0000000e2508', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'Cajera', 'cashier', true),
  ('00000000-0000-0000-0000-0000000e2515', '00000000-0000-0000-0000-0000000e2511', '00000000-0000-0000-0000-0000000e2512', 'Dueño B', 'owner', true);
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000e2520', '00000000-0000-0000-0000-0000000e2501', '1', 'Asado', 'kg', 9000, 15000),
  ('00000000-0000-0000-0000-0000000e2521', '00000000-0000-0000-0000-0000000e2501', '2', 'Vacío', 'kg', 9000, 16000);

-- s-keep: la que queda (sin formatos todavía, usada hace 5 días). s-a: imprime 22AA… y es la más usada (ayer).
-- s-b: sin formatos, nunca se conectó. k-1: Kretz. t-1 / t-2: mismas identidad, formatos distintos.
insert into scale_profiles (company_id, branch_id, scale_key, brand, model, name, family, identity, last_seen_at, weighed_format, unit_format, total_format, amount_decimals, install, active) values
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-keep', 'systel', 'Cuora Max', 'Mostrador', 'systel', '{"address":20}', now() - interval '5 days', null, null, null, 0, '{"sentAt":"viejo","sentCount":3,"model":"vieja"}', true),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 'systel', 'Cuora Max', 'Cuora Max 2', 'systel', '{"address":20}', now() - interval '1 day', '22AAAAPPPPPP', null, '29TTTTTTTTTT', 2, '{"sentAt":"nuevo","verifiedCount":40}', true),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-b', 'systel', 'Cuora Max', 'Cuora Max 3', 'systel', '{"address":20}', null, null, null, null, 0, '{}', true),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'k-1', 'kretz', 'Report', 'Kretz', 'kretz', '{"address":20}', now(), null, null, null, 0, '{}', true),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 't-1', 'systel', 'Cuora', 'Fondo', 'systel', '{"address":30}', now(), '22AAAAPPPPPP', null, null, 0, '{}', true),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 't-2', 'systel', 'Cuora', 'Fondo 2', 'systel', '{"address":30}', now(), '22BBBBIIIIII', null, null, 0, '{}', true),
  ('00000000-0000-0000-0000-0000000e2511', '00000000-0000-0000-0000-0000000e2512', 'x-1', 'systel', 'Cuora', 'B1', 'systel', '{"address":20}', now(), null, null, null, 0, '{}', true),
  ('00000000-0000-0000-0000-0000000e2511', '00000000-0000-0000-0000-0000000e2512', 'x-2', 'systel', 'Cuora', 'B2', 'systel', '{"address":20}', now(), null, null, null, 0, '{}', true);

-- Catálogo: código 1 está en los tres (el que queda sin vincular, s-a vinculado); 2 solo en s-a; 3 en s-a y s-b
-- (s-b leído más tarde, s-a vinculado: gana el vinculado).
insert into scale_catalog_items (company_id, branch_id, scale_key, code, name, sale_type, read_at, link_kind, product_id, linked_at) values
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-keep', 1, 'ASADO', 'P', now() - interval '5 days', 'none', null, null),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 1, 'ASADO', 'P', now() - interval '1 day', 'product', '00000000-0000-0000-0000-0000000e2520', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 2, 'VACIO', 'P', now() - interval '1 day', 'product', '00000000-0000-0000-0000-0000000e2521', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 3, 'CHORIZO', 'P', now() - interval '2 days', 'libre', null, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-b', 3, 'CHORIZO', 'P', now(), 'none', null, null),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-b', 4, 'MORCILLA', 'U', now(), 'none', null, null);

-- Papeles cobrados: el mismo papel (día + huella) cobrado vez 1 en s-keep y vez 1 en s-a; otro solo en s-b.
insert into pos_shifts (id, company_id, branch_id, status, opened_by) values
  ('00000000-0000-0000-0000-0000000e2530', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 'open', '00000000-0000-0000-0000-0000000e2508');
insert into pos_sales (id, company_id, branch_id, total, created_by, pos_shift_id) values
  ('00000000-0000-0000-0000-0000000e2531', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 1000, '00000000-0000-0000-0000-0000000e2508', '00000000-0000-0000-0000-0000000e2530'),
  ('00000000-0000-0000-0000-0000000e2532', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 1000, '00000000-0000-0000-0000-0000000e2508', '00000000-0000-0000-0000-0000000e2530'),
  ('00000000-0000-0000-0000-0000000e2533', '00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 2000, '00000000-0000-0000-0000-0000000e2508', '00000000-0000-0000-0000-0000000e2530');
insert into pos_scale_paper_claims (company_id, branch_id, scale_key, sale_id, ticket_date, fingerprint, occurrence, total, created_by, created_at) values
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-keep', '00000000-0000-0000-0000-0000000e2531', current_date, 'papel-1', 1, 1000, '00000000-0000-0000-0000-0000000e2508', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', '00000000-0000-0000-0000-0000000e2532', current_date, 'papel-1', 1, 1000, '00000000-0000-0000-0000-0000000e2508', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-b', '00000000-0000-0000-0000-0000000e2533', current_date, 'papel-2', 1, 2000, '00000000-0000-0000-0000-0000000e2508', now());

-- Envíos (220): dos de s-a, uno de s-b.
insert into scale_jobs (company_id, branch_id, scale_key, kind, status, finished_at, started_at) values
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 'send', 'done', now(), now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-a', 'send', 'done', now(), now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e2501', '00000000-0000-0000-0000-0000000e2502', 's-b', 'test', 'failed', now(), now());

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

set local role authenticated;

-- 1. Candidatos: el grupo de 3 Systel (último uso = el envío de s-b de recién) y el de t-1/t-2 con formatos distintos.
--    La Kretz con el mismo número no entra (otra marca). Lo de la empresa B no se ve.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2505', true);
do $$
declare v jsonb := public.list_duplicate_scale_candidates('00000000-0000-0000-0000-0000000e2502');
declare g jsonb;
begin
  if jsonb_array_length(v) <> 2 then raise exception 'se esperaban 2 grupos: %', v; end if;
  select x into g from jsonb_array_elements(v) x where x -> 'identity' = '{"address":20}';
  if jsonb_array_length(g -> 'scales') <> 3 then raise exception 'el grupo de 20 no tiene 3: %', g; end if;
  if (g ->> 'formats_differ')::boolean then raise exception 'formatos: los nulos no cuentan como distintos'; end if;
  if g -> 'scales' -> 0 ->> 'scale_key' <> 's-b' then raise exception 'primero el usado más recientemente (envío de s-b): %', g; end if;
  select x into g from jsonb_array_elements(v) x where x -> 'identity' = '{"address":30}';
  if not (g ->> 'formats_differ')::boolean then raise exception 'el grupo de 30 tiene formatos distintos'; end if;
end $$;

-- 2. Otros roles: rechazado. Otra empresa: no encuentra nada de A.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2507', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-a'])$q$, 'encargado une');
  perform pg_temp.must_fail($q$select public.list_duplicate_scale_candidates('00000000-0000-0000-0000-0000000e2502')$q$, 'encargado lista');
  perform pg_temp.must_fail($q$select public.mark_scales_distinct('00000000-0000-0000-0000-0000000e2502', array['t-1', 't-2'])$q$, 'encargado marca');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2508', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-a'])$q$, 'cajera une');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2515', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-a'])$q$, 'otra empresa une');
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2512', 'x-1', array['s-a'])$q$, 'clave de otra empresa');
end $$;

-- 3. Formatos distintos: no une nada y devuelve el detalle. Marcas distintas: error.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2506', true);
do $$
declare r jsonb := public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 't-1', array['t-2']);
begin
  if (r ->> 'merged')::boolean or r ->> 'reason' <> 'formatos_distintos' or jsonb_array_length(r -> 'detail') <> 2 then raise exception 'formatos distintos: %', r; end if;
  if exists (select 1 from scale_profiles where scale_key in ('t-1', 't-2') and (merged_into is not null or not active)) then raise exception 'tocó algo con formatos distintos'; end if;
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['k-1'])$q$, 'marcas distintas');
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['no-existe'])$q$, 'clave inexistente');
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-keep'])$q$, 'nada para unir');
end $$;

-- 4. "Son distintas": el grupo de 30 no se vuelve a preguntar.
do $$
begin
  perform public.mark_scales_distinct('00000000-0000-0000-0000-0000000e2502', array['t-1', 't-2']);
  if jsonb_array_length(public.list_duplicate_scale_candidates('00000000-0000-0000-0000-0000000e2502')) <> 1 then raise exception '"son distintas" no se recordó'; end if;
  if not exists (select 1 from audit_log where action = 'scale.distinct') then raise exception 'sin auditoría de son distintas'; end if;
end $$;

-- 5. Unir s-a y s-b en s-keep (el administrador).
do $$
declare r jsonb := public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-a', 's-b', 's-a']);
declare k scale_profiles%rowtype;
begin
  if not (r ->> 'merged')::boolean then raise exception 'no unió: %', r; end if;
  select * into k from scale_profiles where scale_key = 's-keep';
  -- Ficha: formatos del que los tenía, install con lo más reciente, última conexión la más nueva, sigue activa.
  if k.weighed_format <> '22AAAAPPPPPP' or k.total_format <> '29TTTTTTTTTT' or k.amount_decimals <> 2 then raise exception 'formatos: %', row_to_json(k); end if;
  if k.install ->> 'sentAt' <> 'nuevo' or k.install ->> 'model' <> 'vieja' or (k.install ->> 'verifiedCount')::int <> 40 then raise exception 'install: %', k.install; end if;
  if k.last_seen_at < now() - interval '2 days' then raise exception 'última conexión'; end if;
  if not k.active or k.merged_into is not null or k.name <> 'Mostrador' then raise exception 'la que queda cambió: %', row_to_json(k); end if;
  -- Los unidos: apagados, apuntando a la que queda, sin borrar.
  if (select count(*) from scale_profiles where scale_key in ('s-a', 's-b') and merged_into = 's-keep' and not active) <> 2 then raise exception 'los unidos'; end if;
  -- Catálogo: 1 (toma el vínculo de s-a), 2 (pasa), 3 (el vinculado de s-a), 4 (pasa de s-b). Nada queda en los unidos.
  if (select count(*) from scale_catalog_items where scale_key = 's-keep') <> 4 then raise exception 'catálogo: %', (select jsonb_agg(to_jsonb(i)) from scale_catalog_items i); end if;
  if (select product_id from scale_catalog_items where scale_key = 's-keep' and code = 1) <> '00000000-0000-0000-0000-0000000e2520' then raise exception 'vínculo del 1'; end if;
  if (select link_kind from scale_catalog_items where scale_key = 's-keep' and code = 3) <> 'libre' then raise exception 'el 3 tenía que ser el vinculado'; end if;
  if exists (select 1 from scale_catalog_items where scale_key in ('s-a', 's-b')) then raise exception 'quedó catálogo en los unidos'; end if;
  -- Papeles: todos en s-keep; el papel-1 queda vez 1 y vez 2 por orden de cobro.
  if (select count(*) from pos_scale_paper_claims where scale_key = 's-keep') <> 3 then raise exception 'papeles'; end if;
  if (select occurrence from pos_scale_paper_claims where sale_id = '00000000-0000-0000-0000-0000000e2531') <> 1
     or (select occurrence from pos_scale_paper_claims where sale_id = '00000000-0000-0000-0000-0000000e2532') <> 2
     or (select occurrence from pos_scale_paper_claims where sale_id = '00000000-0000-0000-0000-0000000e2533') <> 1 then
    raise exception 'renumerar: %', (select jsonb_agg(jsonb_build_object('sale', sale_id, 'occ', occurrence)) from pos_scale_paper_claims);
  end if;
  -- Envíos: los 3 en s-keep.
  if (select count(*) from scale_jobs where scale_key = 's-keep') <> 3 or exists (select 1 from scale_jobs where scale_key in ('s-a', 's-b')) then raise exception 'envíos'; end if;
  -- Auditoría con lo que se borró por repetido.
  if not exists (select 1 from audit_log where action = 'scale.merge' and entity_id = 's-keep' and jsonb_array_length(new_data -> 'catalog_removed') = 2
                 and new_data -> 'merged' = '["s-a", "s-b"]'::jsonb and (new_data ->> 'paper_claims')::int = 2 and (new_data ->> 'jobs')::int = 3) then
    raise exception 'auditoría: %', (select jsonb_agg(new_data) from audit_log where action = 'scale.merge');
  end if;
  -- Ya no hay candidatos, y no se puede volver a unir lo unido.
  if jsonb_array_length(public.list_duplicate_scale_candidates('00000000-0000-0000-0000-0000000e2502')) <> 0 then raise exception 'siguen apareciendo'; end if;
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-a', array['s-keep'])$q$, 'unir a una unida');
  perform pg_temp.must_fail($q$select public.merge_branch_scales('00000000-0000-0000-0000-0000000e2502', 's-keep', array['s-b'])$q$, 'unir de nuevo');
  -- Una venta nueva del mismo papel sigue con max + 1.
  if (select coalesce(max(occurrence), 0) + 1 from pos_scale_paper_claims where scale_key = 's-keep' and fingerprint = 'papel-1') <> 3 then raise exception 'max + 1'; end if;
end $$;

-- 6. Sin escrituras directas en las columnas nuevas.
do $$
begin
  perform pg_temp.must_fail($q$update scale_profiles set merged_into = null where scale_key = 's-a'$q$, 'update directo');
end $$;

reset role;

-- 7. Una unida no se puede volver a prender a mano (queda apuntando a la que queda).
do $$
begin
  perform pg_temp.must_fail($q$update scale_profiles set active = true where scale_key = 's-a'$q$, 'prender una unida');
end $$;

rollback;
