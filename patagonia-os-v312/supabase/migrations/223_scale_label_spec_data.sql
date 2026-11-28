-- 223: DATOS. Carga el perfil de etiqueta (label_spec, migración 222) de cada balanza YA registrada con EXACTAMENTE
-- lo que el código hace hoy. 27/11/2026. **La revisa el dueño antes de aplicarla** (cambia datos existentes).
--
-- Nada cambia en lo que se ve: la web solo lee estos perfiles en las empresas con 'balanzas_v2' encendido, y la
-- prueba de equivalencia (apps/web/src/features/sale/scale-labels-equivalence.test.ts) lee las 81 etiquetas reales
-- del banco de regresión con estos mismos perfiles y da idéntico que hoy.
--
-- Qué carga, por balanza (solo las que todavía no tienen perfil: se puede correr dos veces):
-- 1. Las 4 listas por cliente de apps/web/src/features/scales/engine/weight-barcode.ts (los UUID están acá porque son
--    un DATO, no código; label-spec.ts las tiene sin UUID en LEGACY_LIST_1070):
--    - REPORT_WEIGHT_BARCODE_COMPANIES (Carplat): las Report de la empresa → 1070 "2112005" ("21" + gramos).
--    - REPORT_PESOS_BARCODE_COMPANIES (El Abastero): las Report → 1070 "2002001" (lectura 1-6-5 en pesos).
--    - REPORT_PLU5_WEIGHT_COMPANIES (Oliem): las Report → 1070 "2112001" (2-5-5 con peso).
--    - AURA_PREFIX_22_BRANCHES (sucursal de El Abastero): las Aura de esa sucursal → 1070 "2202205" (inicio 22).
--    "Report" = Kretz que no es Aura (en el código, la lista se aplica a toda Kretz que no sea Aura).
-- 2. El resto: el formato de la sucursal (branch_scale_configs; si no tiene, el de fábrica 1-5-5) como lectura, y
--    como escritura lo que se le manda hoy: Aura "2002005"; Systel 20/21 + producto 4 + cantidad 6; Report null (lo
--    decide la conexión: por red "2112001", por cable "2002005", igual que hoy). Mismas reglas que specFromToday.
-- 3. Inicios reservados (scale_label_prefixes): por sucursal, de la balanza más vieja a la más nueva, cada una reserva
--    sus inicios si no se pisan con los de una anterior. La que choca queda SIN inicios reservados (su perfil igual se
--    lee: si lee lo mismo que la otra no hay diferencia, y si no, la regla de ambigüedad) y se informa con NOTICE: recibe
--    un inicio propio cuando se la registre/conecte con 'balanzas_v2'.
-- Todo con origin "223:…" (vuelta atrás: 223_scale_label_spec_data.rollback.sql).

-- La carga vive en una función (interna, cerrada) para que tests/sql/223 la pueda correr sobre datos de prueba.
create or replace function public.scale_label_spec_load_223()
returns jsonb
language plpgsql
security definer
set search_path = public
as $mig$
declare
  r record;
  v_list text;
  v_spec jsonb;
  v_c record;
  v_p text;
  v_read jsonb;
  v_value text;
  v_pref text;
  v_aura boolean;
  v_loaded int := 0;
  v_skipped int := 0;
begin
  -- Iguales a specFromToday({ list }) de label-spec.ts (label-spec.test.ts compara estas líneas).
  create temp table if not exists tmp_223_lists (list text primary key, spec jsonb not null) on commit drop;
  insert into tmp_223_lists values
    ('report_peso', '{"v":1,"prefixes":{"weighed":"21","unit":"20","total":"20"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","weighedValue":"weight_g","sumCode":998,"writer":{"kind":"kretz1070","code":"2112005"},"origin":"223:lista"}'::jsonb),
    ('report_pesos', '{"v":1,"prefixes":{"weighed":"20","unit":"20","total":"20"},"layout":{"prefix":1,"code":6,"value":5,"length":13,"divisor":1},"value":"amount_pesos","sumCode":99998,"writer":{"kind":"kretz1070","code":"2002001"},"origin":"223:lista"}'::jsonb),
    ('report_plu5', '{"v":1,"prefixes":{"weighed":"21","unit":"20","total":"20"},"layout":{"prefix":2,"code":5,"value":5,"length":13,"divisor":1000},"value":"weight_g","unitValue":"amount_pesos","sumCode":null,"writer":{"kind":"kretz1070","code":"2112001"},"origin":"223:lista"}'::jsonb),
    ('aura_22', '{"v":1,"prefixes":{"weighed":"22","unit":"22","total":"22"},"layout":{"prefix":2,"code":3,"value":7,"length":13,"divisor":100},"value":"amount_cents","sumCode":998,"writer":{"kind":"kretz1070","code":"2202205"},"origin":"223:lista"}'::jsonb)
  on conflict (list) do nothing;

  for r in
    select sp.company_id, sp.branch_id, sp.scale_key, sp.name, sp.family, sp.model, sp.total_format
    from public.scale_profiles sp
    where sp.label_spec is null
    order by sp.branch_id, sp.created_at, sp.scale_key
  loop
    v_aura := coalesce(r.model, '') ilike '%aura%';
    v_list := case
      when r.family = 'kretz' and v_aura and r.branch_id = 'b92aa128-3062-43ea-91f0-97f99469a173' then 'aura_22'          -- El Abastero (sucursal)
      when r.family = 'kretz' and not v_aura and r.company_id = 'ded6465d-2d7d-43d2-97df-0945e1871dbf' then 'report_peso'  -- Carplat S.A.
      when r.family = 'kretz' and not v_aura and r.company_id = 'b3269949-1e03-4509-bc35-2608e6ec4bfc' then 'report_pesos' -- El Abastero
      when r.family = 'kretz' and not v_aura and r.company_id = '9c810ff0-e945-41d7-9c0c-921626a83694' then 'report_plu5'  -- Oliem minimarket
    end;

    if v_list is not null then
      select spec into v_spec from tmp_223_lists where list = v_list;
    else
      select prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type into v_c
      from public.branch_scale_configs where branch_id = r.branch_id;
      v_read := case when v_c.prefix_length is null
        then '{"prefix":1,"code":5,"value":5,"length":13,"divisor":1000}'::jsonb
        else jsonb_build_object('prefix', v_c.prefix_length, 'code', v_c.plu_length, 'value', v_c.weight_length,
                                'length', v_c.total_length, 'divisor', v_c.weight_divisor::int) end;
      v_value := case when v_c.prefix_length is null or v_c.payload_type = 'weight' then 'weight_g'
                      when v_c.weight_divisor = 1 then 'amount_pesos' else 'amount_cents' end;
      if r.family = 'systel' then
        v_spec := jsonb_build_object(
          'v', 1,
          'prefixes', jsonb_build_object('weighed', '20', 'unit', '21',
            'total', case when r.total_format ~ '^2[0-9]' and left(r.total_format, 2) not in ('20', '21') then left(r.total_format, 2) end),
          'layout', v_read, 'value', v_value, 'unitValue', 'units', 'sumCode', null,
          'writer', jsonb_build_object('kind', 'systel', 'weighed', '20PPPPCCCCCC', 'unit', '21PPPPCCCCCC'));
      else
        v_pref := case when (v_read->>'prefix') = '2' then '20' else '2' end;
        v_spec := jsonb_build_object(
          'v', 1,
          'prefixes', jsonb_build_object('weighed', v_pref, 'unit', v_pref, 'total', v_pref),
          'layout', v_read, 'value', v_value,
          'sumCode', case when v_aura then 998 end,
          'writer', case when v_aura then '{"kind":"kretz1070","code":"2002005"}'::jsonb else 'null'::jsonb end);
      end if;
      v_spec := v_spec || jsonb_build_object('origin', case when v_c.prefix_length is null then '223:fabrica' else '223:sucursal' end);
    end if;

    if public.scale_label_spec_problem(v_spec) is not null then
      raise notice '223: balanza % (%) de la sucursal %: el formato no sirve como perfil (%), queda sin perfil',
        r.scale_key, coalesce(r.name, r.model), r.branch_id, public.scale_label_spec_problem(v_spec);
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.scale_profiles set label_spec = v_spec
    where company_id = r.company_id and branch_id = r.branch_id and scale_key = r.scale_key and label_spec is null;
    v_loaded := v_loaded + 1;
  end loop;

  -- Inicios reservados: de la más vieja a la más nueva, por sucursal, sin pisarse.
  for r in
    select sp.company_id, sp.branch_id, sp.scale_key, sp.name, sp.model, sp.label_spec
    from public.scale_profiles sp
    where sp.label_spec->>'origin' like '223:%' and sp.status = 'active'
      and not exists (select 1 from public.scale_label_prefixes x where x.company_id = sp.company_id and x.branch_id = sp.branch_id and x.scale_key = sp.scale_key)
    order by sp.branch_id, sp.created_at, sp.scale_key
  loop
    if exists (
      select 1 from public.scale_label_prefixes x, unnest(public.scale_label_spec_prefixes(r.label_spec)) n
      where x.branch_id = r.branch_id and x.active and (n like x.prefix || '%' or x.prefix like n || '%')
    ) then
      raise notice '223: balanza % (%) de la sucursal %: su inicio ya lo usa otra balanza del local; recibe uno propio al conectarla con balanzas_v2',
        r.scale_key, coalesce(r.name, r.model), r.branch_id;
      continue;
    end if;
    foreach v_p in array public.scale_label_spec_prefixes(r.label_spec) loop
      insert into public.scale_label_prefixes (company_id, branch_id, scale_key, prefix) values (r.company_id, r.branch_id, r.scale_key, v_p)
      on conflict do nothing;
    end loop;
  end loop;

  raise notice '223: % balanzas con perfil cargado, % sin perfil', v_loaded, v_skipped;
  -- Listas de clientes sin la balanza registrada: con 'balanzas_v2' esa balanza se leería con el formato de la sucursal.
  if not exists (select 1 from public.scale_profiles where branch_id = 'b92aa128-3062-43ea-91f0-97f99469a173' and family = 'kretz' and coalesce(model, '') ilike '%aura%') then
    raise notice '223: la Aura con inicio 22 (sucursal de El Abastero) no está registrada: no encender balanzas_v2 ahí hasta registrarla';
  end if;
  return jsonb_build_object('cargadas', v_loaded, 'sin_perfil', v_skipped);
end
$mig$;
revoke all on function public.scale_label_spec_load_223() from public, anon, authenticated;

select public.scale_label_spec_load_223();

insert into public.schema_migrations (version) values ('223_scale_label_spec_data') on conflict do nothing;
