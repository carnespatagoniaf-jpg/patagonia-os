-- Pruebas de la migración 222 (perfil de etiqueta por balanza e inicio propio). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000e2001', 'Carnicería A', 9931, 'estandar'),
  ('00000000-0000-0000-0000-0000000e2011', 'Carnicería B', 9932, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000e2002', '00000000-0000-0000-0000-0000000e2001', 'Centro'),
  ('00000000-0000-0000-0000-0000000e2003', '00000000-0000-0000-0000-0000000e2001', 'Norte'),
  ('00000000-0000-0000-0000-0000000e2012', '00000000-0000-0000-0000-0000000e2011', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e2005', 'duenio@a'), ('00000000-0000-0000-0000-0000000e2006', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000e2007', 'lectura@a'), ('00000000-0000-0000-0000-0000000e2008', 'contador@a'),
  ('00000000-0000-0000-0000-0000000e2015', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000e2005', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Dueño', 'owner', true),
  ('00000000-0000-0000-0000-0000000e2006', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Cajera', 'cashier', true),
  ('00000000-0000-0000-0000-0000000e2007', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Lectura', 'readonly', true),
  ('00000000-0000-0000-0000-0000000e2008', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'Contador', 'accountant', true),
  ('00000000-0000-0000-0000-0000000e2015', '00000000-0000-0000-0000-0000000e2011', '00000000-0000-0000-0000-0000000e2012', 'Dueño B', 'owner', true);

create function pg_temp.must_fail(p_sql text, p_label text, p_contains text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_contains is not null and position(p_contains in sqlerrm) = 0 then
      raise exception '% falló, pero con otro motivo: %', p_label, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text, text) to authenticated;

-- Estructura: funciones internas cerradas, tabla sin escritura directa, interruptor en la lista.
do $$
begin
  if has_function_privilege('authenticated', 'public.scale_label_apply(uuid,uuid,text,jsonb,uuid,text)', 'execute') then raise exception 'scale_label_apply abierta'; end if;
  if has_function_privilege('authenticated', 'public.scale_label_caller(uuid,text)', 'execute') then raise exception 'scale_label_caller abierta'; end if;
  if has_function_privilege('authenticated', 'public.scale_label_spec_problem(jsonb)', 'execute') then raise exception 'scale_label_spec_problem abierta'; end if;
  if has_table_privilege('authenticated', 'public.scale_label_prefixes', 'insert') then raise exception 'scale_label_prefixes con insert directo'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_accountant_readonly' and tgrelid = 'public.scale_label_prefixes'::regclass) then raise exception 'falta zz_accountant_readonly'; end if;
  if position('''balanzas_v2''' in pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure)) = 0 then raise exception 'balanzas_v2 no está en set_company_feature'; end if;
  -- El perfil con inicio propio es el mismo que arma label-spec.ts (specWithOwnPrefix).
  if public.scale_label_spec_with_prefix('kretz', '22', null) <> '{"v":1,"prefixes":{"weighed":"22","unit":"22","total":"22"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":998,"writer":{"kind":"kretz1070","code":"2202205"},"origin":"asignado"}'::jsonb then
    raise exception 'perfil Kretz 22 distinto: %', public.scale_label_spec_with_prefix('kretz', '22', null);
  end if;
  if public.scale_label_spec_with_prefix('systel', '20', '22AAIIIIIIII') <> '{"v":1,"prefixes":{"weighed":"20","unit":"21","total":"22"},"layout":{"prefix":2,"code":4,"value":6,"length":13,"divisor":1000},"value":"weight_g","unitValue":"units","sumCode":null,"writer":{"kind":"systel","weighed":"20PPPPCCCCCC","unit":"21PPPPCCCCCC"},"origin":"systel"}'::jsonb then
    raise exception 'perfil Systel 20 distinto';
  end if;
  if public.scale_label_spec_with_prefix('systel', '23', '22AAIIIIIIII') <> '{"v":1,"prefixes":{"weighed":"23","unit":"23","total":null},"layout":{"prefix":2,"code":4,"value":6,"length":13,"divisor":1000},"value":"weight_g","unitValue":"units","sumCode":null,"writer":{"kind":"systel","weighed":"23PPPPCCCCCC","unit":"23PPPPCCCCCC"},"origin":"asignado"}'::jsonb then
    raise exception 'perfil Systel 23 distinto';
  end if;
  -- Validación igual que labelSpecProblem.
  if public.scale_label_spec_problem(public.scale_label_spec_with_prefix('kretz', '25', null)) is not null then raise exception 'perfil válido rechazado'; end if;
  if public.scale_label_spec_problem('{"v":1,"prefixes":{"weighed":"30","unit":null,"total":null},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":null,"writer":null}') is null then raise exception 'inicio 30 aceptado'; end if;
  if public.scale_label_spec_problem('{"v":1,"prefixes":{"weighed":"20","unit":null,"total":null},"layout":{"prefix":2,"code":5,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":null,"writer":null}') is null then raise exception 'cifras de más aceptadas'; end if;
  if public.scale_label_spec_problem('{"v":1,"prefixes":{"weighed":"20","unit":null,"total":null},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":null,"writer":{"kind":"kretz1070","code":"9999999"}}') is null then raise exception '1070 inválido aceptado'; end if;
end $$;

-- Perfiles para usar como authenticated (las funciones internas están cerradas).
create temp table specs (k text primary key, s jsonb);
insert into specs values ('kretz20', public.scale_label_spec_with_prefix('kretz', '20', null)),
  ('kretz24', public.scale_label_spec_with_prefix('kretz', '24', null)), ('systel24', public.scale_label_spec_with_prefix('systel', '24', null));
grant select on specs to authenticated;

set local role authenticated;

-- 1. El dueño registra dos Kretz en Centro: la primera recibe el inicio de siempre (20), la segunda uno libre (22).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
do $$
declare r jsonb;
begin
  perform public.register_branch_scale('00000000-0000-0000-0000-0000000e2002', 'kretz-report', 'Report', 'kretz', 'kretz', 'Kretz Report', '{}');
  perform public.register_branch_scale('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', 'Aura', 'kretz', 'kretz', 'Kretz Aura', '{}');
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report');
  if r->>'prefix' <> '20' or (r->>'changed')::boolean is not true or r->'spec'->'writer'->>'code' <> '2002005' then raise exception 'primera: %', r; end if;
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-aura');
  if r->>'prefix' <> '22' or r->'spec'->'writer'->>'code' <> '2202205' then raise exception 'segunda: %', r; end if;
  -- Volver a pedir: cada una conserva el suyo, sin cambios.
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report');
  if r->>'prefix' <> '20' or (r->>'changed')::boolean then raise exception 'la vieja cambió: %', r; end if;
  -- Otra sucursal de la misma empresa es otro local: ahí el 20 está libre.
  perform public.register_branch_scale('00000000-0000-0000-0000-0000000e2003', 'kretz-norte', 'Norte', 'kretz', 'kretz', 'Kretz Report', '{}');
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2003', 'kretz-norte');
  if r->>'prefix' <> '20' then raise exception 'otra sucursal: %', r; end if;
end $$;

-- 2. Una Systel en el mismo local: 20/21/22 chocan (20 Report, 22 Aura) → 23 para pesables y unitarios.
do $$
declare r jsonb;
begin
  perform public.register_branch_scale('00000000-0000-0000-0000-0000000e2002', 'systel-max', 'Cuora', 'systel', 'systel', 'Systel Cuora Max', '{}');
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'systel-max');
  if r->>'prefix' <> '23' or r->'spec'->'writer'->>'weighed' <> '23PPPPCCCCCC' or r->'spec'->'writer'->>'unit' <> '23PPPPCCCCCC' then raise exception 'systel: %', r; end if;
  if (select count(*) from public.scale_label_prefixes where branch_id = '00000000-0000-0000-0000-0000000e2002' and active) <> 3 then raise exception 'inicios reservados'; end if;
end $$;

-- 3. La base impide dos balanzas con el mismo inicio (o que se pisan) en el local.
select pg_temp.must_fail($q$select public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', public_spec.s)
  from (select '{"v":1,"prefixes":{"weighed":"20","unit":"20","total":"20"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":998,"writer":{"kind":"kretz1070","code":"2002005"}}'::jsonb as s) public_spec$q$,
  'mismo inicio que la Report', 'ya lo usa la balanza "Report"');
select pg_temp.must_fail($q$select public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura',
  '{"v":1,"prefixes":{"weighed":"2","unit":"2","total":"2"},"layout":{"prefix":1,"code":6,"value":5,"length":13,"divisor":1},"value":"amount_pesos","sumCode":null,"writer":null}'::jsonb)$q$,
  'inicio "2" se pisa con 20/22/23', 'ya lo usa la balanza');
-- Perfil inválido o de otra marca.
select pg_temp.must_fail($q$select public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', '{"v":2}'::jsonb)$q$, 'perfil inválido', 'Perfil de etiqueta inválido');
select pg_temp.must_fail($q$select public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', (select s from specs where k = 'systel24'))$q$, 'perfil Systel en una Kretz', 'no es de una balanza kretz');

-- 4. Cambiar el perfil: el anterior queda vigente 7 días en el historial, y queda en audit_log.
do $$
declare v_hist jsonb;
begin
  perform public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', (select s from specs where k = 'kretz24'));
  select label_spec_history into v_hist from public.scale_profiles where scale_key = 'kretz-aura';
  if jsonb_array_length(v_hist) <> 1 or v_hist->0->'spec'->'writer'->>'code' <> '2202205' then raise exception 'historial: %', v_hist; end if;
  if (v_hist->0->>'valid_until')::timestamptz < now() + interval '6 days 23 hours' then raise exception 'vigencia corta'; end if;
  if not exists (select 1 from public.scale_label_prefixes where scale_key = 'kretz-aura' and prefix = '24') or exists (select 1 from public.scale_label_prefixes where scale_key = 'kretz-aura' and prefix = '22') then
    raise exception 'inicios de la Aura no se cambiaron';
  end if;
  -- Mismo perfil otra vez: no suma historial.
  perform public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-aura', (select s from specs where k = 'kretz24'));
  if jsonb_array_length((select label_spec_history from public.scale_profiles where scale_key = 'kretz-aura')) <> 1 then raise exception 'historial duplicado'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from public.audit_log where action = 'scale.label_spec' and entity_id = 'kretz-aura') then raise exception 'sin auditoría del perfil'; end if;
  if not exists (select 1 from public.audit_log where action = 'scale.prefix_allocate' and entity_id = 'systel-max') then raise exception 'sin auditoría de la asignación'; end if;
end $$;
-- La garantía dura: aunque alguien escribiera directo (postgres), el índice único frena el mismo inicio.
select pg_temp.must_fail($q$insert into public.scale_label_prefixes (company_id, branch_id, scale_key, prefix) values ('00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000e2002', 'kretz-aura', '20')$q$, 'índice único', 'scale_label_prefixes_branch_prefix_active');
set local role authenticated;

-- 5. La cajera (manda productos) puede; solo lectura y el contador no; otra empresa tampoco.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2006', true);
select public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2007', true);
select pg_temp.must_fail($q$select public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report')$q$, 'solo lectura', 'No tenés permiso');
select pg_temp.must_fail($q$select public.set_scale_label_spec('00000000-0000-0000-0000-0000000e2002', 'kretz-report', (select s from specs where k = 'kretz20'))$q$, 'solo lectura (perfil)', 'No tenés permiso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2008', true);
select pg_temp.must_fail($q$select public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report')$q$, 'contador');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2015', true);
select pg_temp.must_fail($q$select public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report')$q$, 'otra empresa', 'Sucursal inválida');
do $$
begin
  if exists (select 1 from public.scale_label_prefixes) then raise exception 'la otra empresa ve los inicios de A'; end if;
end $$;
select pg_temp.must_fail($q$select public.set_branch_scale_status('00000000-0000-0000-0000-0000000e2002', 'kretz-report', 'inactive')$q$, 'otra empresa (estado)', 'no está en esa sucursal');

-- 6. Desactivar una balanza libera sus inicios; reactivarla con un inicio ya tomado no se puede.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2006', true);
select pg_temp.must_fail($q$select public.set_branch_scale_status('00000000-0000-0000-0000-0000000e2002', 'kretz-report', 'inactive')$q$, 'cajera desactiva', 'No tenés permiso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2005', true);
do $$
declare r jsonb;
begin
  perform public.set_branch_scale_status('00000000-0000-0000-0000-0000000e2002', 'kretz-report', 'inactive');
  if exists (select 1 from public.scale_label_prefixes where scale_key = 'kretz-report' and active) then raise exception 'sigue reservando'; end if;
  -- Una Kretz nueva ahora puede tomar el 20.
  perform public.register_branch_scale('00000000-0000-0000-0000-0000000e2002', 'kretz-nueva', 'Nueva', 'kretz', 'kretz', 'Kretz Report', '{}');
  r := public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-nueva');
  if r->>'prefix' <> '20' then raise exception 'no tomó el 20 libre: %', r; end if;
end $$;
select pg_temp.must_fail($q$select public.set_branch_scale_status('00000000-0000-0000-0000-0000000e2002', 'kretz-report', 'active')$q$, 'reactivar con inicio tomado', 'mismo inicio');
select pg_temp.must_fail($q$select public.allocate_scale_prefix('00000000-0000-0000-0000-0000000e2002', 'kretz-report')$q$, 'asignar a una desactivada', 'desactivada');

-- 7. Quitar la balanza borra sus inicios (cascada).
do $$
begin
  perform public.remove_branch_scale('00000000-0000-0000-0000-0000000e2002', 'systel-max');
  if exists (select 1 from public.scale_label_prefixes where scale_key = 'systel-max') then raise exception 'quedaron inicios de una balanza quitada'; end if;
end $$;

rollback;
