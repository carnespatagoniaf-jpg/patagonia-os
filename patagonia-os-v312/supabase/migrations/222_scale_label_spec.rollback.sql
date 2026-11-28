-- VUELTA ATRÁS de 222_scale_label_spec.sql. La 222 es aditiva: la web sin 'balanzas_v2' no usa nada de esto.
-- Ojo: se pierden los perfiles de etiqueta, su historial y los inicios reservados (exportar antes scale_profiles.label_spec
-- y scale_label_prefixes si hace falta). Si la 223 ya se aplicó, correr antes 223_scale_label_spec_data.rollback.sql.
-- Antes de esto, apagar 'balanzas_v2' en todas las empresas (la web vuelve a leer con el formato de la sucursal).

drop function if exists public.set_branch_scale_status(uuid, text, text);
drop function if exists public.allocate_scale_prefix(uuid, text);
drop function if exists public.set_scale_label_spec(uuid, text, jsonb);
drop function if exists public.scale_label_caller(uuid, text);
drop function if exists public.scale_label_apply(uuid, uuid, text, jsonb, uuid, text);
drop trigger if exists scale_profiles_status_prefixes on public.scale_profiles;
drop function if exists public.scale_profiles_status_prefixes();
drop table if exists public.scale_label_prefixes;
drop function if exists public.scale_label_spec_with_prefix(text, text, text);
drop function if exists public.scale_label_spec_prefixes(jsonb);
drop function if exists public.scale_label_spec_problem(jsonb);

alter table public.scale_profiles drop constraint if exists scale_profiles_label_spec_history_check;
alter table public.scale_profiles drop constraint if exists scale_profiles_status_check;
alter table public.scale_profiles drop column if exists label_spec_history;
alter table public.scale_profiles drop column if exists label_spec;
alter table public.scale_profiles drop column if exists status;

-- Saca 'balanzas_v2' de la lista de set_company_feature (dejando el resto de la definición viva como está).
do $mig$
declare
  v_def text := pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure);
begin
  if position(', ''balanzas_v2''' in v_def) = 0 then return; end if;
  execute replace(v_def, ', ''balanzas_v2''', '');
end
$mig$;
update public.companies set features = array_remove(features, 'balanzas_v2') where 'balanzas_v2' = any (features);

delete from public.schema_migrations where version = '222_scale_label_spec';
