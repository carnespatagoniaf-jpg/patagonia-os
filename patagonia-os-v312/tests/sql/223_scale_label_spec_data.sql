-- Pruebas de la migración 223 (carga de perfiles de etiqueta con lo que el código hace hoy). Se deshace al final.
-- Los perfiles esperados son los mismos que arma specFromToday (label-spec.ts; label-spec.test.ts tiene estas líneas).
\set ON_ERROR_STOP 1
begin;

-- Las empresas y la sucursal de las 4 listas (mismos UUID que weight-barcode.ts) + una empresa cualquiera.
insert into companies (id, name, client_number, plan) values
  ('ded6465d-2d7d-43d2-97df-0945e1871dbf', 'Carplat (prueba)', 9941, 'full'),
  ('b3269949-1e03-4509-bc35-2608e6ec4bfc', 'El Abastero (prueba)', 9942, 'full'),
  ('9c810ff0-e945-41d7-9c0c-921626a83694', 'Oliem (prueba)', 9943, 'full'),
  ('00000000-0000-0000-0000-0000000f2001', 'Otra', 9944, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f2101', 'ded6465d-2d7d-43d2-97df-0945e1871dbf', 'Carplat'),
  ('b92aa128-3062-43ea-91f0-97f99469a173', 'b3269949-1e03-4509-bc35-2608e6ec4bfc', 'EL ABASTERO'),
  ('00000000-0000-0000-0000-0000000f2103', '9c810ff0-e945-41d7-9c0c-921626a83694', 'Oliem'),
  ('00000000-0000-0000-0000-0000000f2104', '00000000-0000-0000-0000-0000000f2001', 'Con formato'),
  ('00000000-0000-0000-0000-0000000f2105', '00000000-0000-0000-0000-0000000f2001', 'Sin formato');
insert into branch_scale_configs (company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type) values
  ('ded6465d-2d7d-43d2-97df-0945e1871dbf', '00000000-0000-0000-0000-0000000f2101', 2, 3, 7, 100, 13, 'amount'),
  ('b3269949-1e03-4509-bc35-2608e6ec4bfc', 'b92aa128-3062-43ea-91f0-97f99469a173', 1, 6, 5, 1, 13, 'amount'),
  ('9c810ff0-e945-41d7-9c0c-921626a83694', '00000000-0000-0000-0000-0000000f2103', 2, 5, 5, 1000, 13, 'weight'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2104', 1, 6, 5, 1000, 13, 'weight');
insert into scale_profiles (company_id, branch_id, scale_key, brand, model, name, family, total_format, created_at) values
  ('ded6465d-2d7d-43d2-97df-0945e1871dbf', '00000000-0000-0000-0000-0000000f2101', 'kretz-cp', 'kretz', 'Kretz Report', 'Report', 'kretz', null, now() - interval '9 days'),
  ('b3269949-1e03-4509-bc35-2608e6ec4bfc', 'b92aa128-3062-43ea-91f0-97f99469a173', 'kretz-ab-report', 'kretz', 'Kretz Report', 'Report', 'kretz', null, now() - interval '9 days'),
  ('b3269949-1e03-4509-bc35-2608e6ec4bfc', 'b92aa128-3062-43ea-91f0-97f99469a173', 'kretz-ab-aura', 'kretz', 'Kretz Aura', 'Aura', 'kretz', null, now() - interval '8 days'),
  ('9c810ff0-e945-41d7-9c0c-921626a83694', '00000000-0000-0000-0000-0000000f2103', 'kretz-ol-red', 'kretz', 'Kretz Report', 'Por red', 'kretz', null, now() - interval '9 days'),
  ('9c810ff0-e945-41d7-9c0c-921626a83694', '00000000-0000-0000-0000-0000000f2103', 'kretz-ol-usb', 'kretz', 'Kretz Report', 'Por USB', 'kretz', null, now() - interval '8 days'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2104', 'kretz-x', 'kretz', 'Kretz Report', 'Kretz', 'kretz', null, now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2104', 'systel-x', 'systel', 'Systel Cuora Max', 'Cuora', 'systel', '22AAIIIIIIII', now() - interval '8 days'),
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2105', 'aura-y', 'kretz', 'Kretz Aura', 'Aura', 'kretz', null, now() - interval '9 days');

do $$
declare
  r jsonb;
  spec jsonb;
  -- Inicios que ya había (en staging o producción, los de la carga real): la prueba cuenta solo los que agrega.
  n0 int := (select count(*) from scale_label_prefixes);
begin
  r := public.scale_label_spec_load_223();
  if (r->>'cargadas')::int <> 8 then raise exception 'cargadas: %', r; end if;

  -- Listas por cliente.
  if (select label_spec from scale_profiles where scale_key = 'kretz-cp') <> '{"v":1,"prefixes":{"weighed":"21","unit":"20","total":"20"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","weighedValue":"weight_g","sumCode":998,"writer":{"kind":"kretz1070","code":"2112005"},"origin":"223:lista"}'::jsonb then raise exception 'Carplat'; end if;
  if (select label_spec->'writer'->>'code' from scale_profiles where scale_key = 'kretz-ab-report') <> '2002001' then raise exception 'El Abastero Report'; end if;
  if (select label_spec from scale_profiles where scale_key = 'kretz-ab-aura') <> '{"v":1,"prefixes":{"weighed":"22","unit":"22","total":"22"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":998,"writer":{"kind":"kretz1070","code":"2202205"},"origin":"223:lista"}'::jsonb then raise exception 'El Abastero Aura 22'; end if;
  if (select count(*) from scale_profiles where scale_key like 'kretz-ol-%' and label_spec->'writer'->>'code' = '2112001') <> 2 then raise exception 'Oliem'; end if;

  -- Resto: formato de la sucursal (o de fábrica) + lo que se le manda hoy.
  if (select label_spec from scale_profiles where scale_key = 'kretz-x') <> '{"v":1,"prefixes":{"weighed":"2","unit":"2","total":"2"},"layout":{"prefix":1,"code":6,"value":5,"length":13,"divisor":1000},"value":"weight_g","sumCode":null,"writer":null,"origin":"223:sucursal"}'::jsonb then
    raise exception 'Kretz genérica: %', (select label_spec from scale_profiles where scale_key = 'kretz-x');
  end if;
  if (select label_spec from scale_profiles where scale_key = 'systel-x') <> '{"v":1,"prefixes":{"weighed":"20","unit":"21","total":"22"},"layout":{"prefix":1,"code":6,"value":5,"length":13,"divisor":1000},"value":"weight_g","unitValue":"units","sumCode":null,"writer":{"kind":"systel","weighed":"20PPPPCCCCCC","unit":"21PPPPCCCCCC"},"origin":"223:sucursal"}'::jsonb then
    raise exception 'Systel genérica: %', (select label_spec from scale_profiles where scale_key = 'systel-x');
  end if;
  if (select label_spec from scale_profiles where scale_key = 'aura-y') <> '{"v":1,"prefixes":{"weighed":"2","unit":"2","total":"2"},"layout":{"prefix":1,"code":5,"value":5,"length":13,"divisor":1000},"value":"weight_g","sumCode":998,"writer":{"kind":"kretz1070","code":"2002005"},"origin":"223:fabrica"}'::jsonb then
    raise exception 'Aura sin formato: %', (select label_spec from scale_profiles where scale_key = 'aura-y');
  end if;
  -- Todos válidos para set_scale_label_spec.
  for spec in select label_spec from scale_profiles where label_spec is not null loop
    if public.scale_label_spec_problem(spec) is not null then raise exception 'perfil inválido: % (%)', spec, public.scale_label_spec_problem(spec); end if;
  end loop;

  -- Inicios: El Abastero Report 20 + Aura 22 (no se pisan); Oliem: la más vieja reserva 20/21, la otra queda sin
  -- reservar (recibe el suyo con balanzas_v2); la Kretz genérica "2" se pisa con la Systel 20/21/22: la Systel sin reservar.
  if (select array_agg(prefix order by prefix) from scale_label_prefixes where branch_id = 'b92aa128-3062-43ea-91f0-97f99469a173') <> array['20', '22'] then raise exception 'inicios El Abastero'; end if;
  if (select array_agg(distinct scale_key) from scale_label_prefixes where branch_id = '00000000-0000-0000-0000-0000000f2103') <> array['kretz-ol-red'] then raise exception 'inicios Oliem'; end if;
  if exists (select 1 from scale_label_prefixes where scale_key = 'systel-x') then raise exception 'la Systel reservó un inicio pisado'; end if;

  -- Se puede correr de nuevo: no cambia nada.
  r := public.scale_label_spec_load_223();
  if (r->>'cargadas')::int <> 0 then raise exception 'segunda vez: %', r; end if;
  if (select count(*) from scale_label_prefixes) - n0 <> 8 then raise exception 'inicios duplicados: %', (select count(*) from scale_label_prefixes) - n0; end if;
  if has_function_privilege('authenticated', 'public.scale_label_spec_load_223()', 'execute') then raise exception 'la carga quedó abierta'; end if;
end $$;

rollback;
