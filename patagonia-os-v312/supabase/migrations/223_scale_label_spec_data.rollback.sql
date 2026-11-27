-- VUELTA ATRÁS de 223_scale_label_spec_data.sql: saca los perfiles que cargó la 223 (origin "223:…") y sus inicios
-- reservados. Los perfiles guardados después (set_scale_label_spec / allocate_scale_prefix) no se tocan. Antes, apagar
-- 'balanzas_v2' en las empresas que lo tengan (sin perfiles, el lector por balanza usa el formato de la sucursal).

delete from public.scale_label_prefixes x
using public.scale_profiles sp
where sp.company_id = x.company_id and sp.branch_id = x.branch_id and sp.scale_key = x.scale_key
  and sp.label_spec->>'origin' like '223:%';
update public.scale_profiles set label_spec = null where label_spec->>'origin' like '223:%';
drop function if exists public.scale_label_spec_load_223();

delete from public.schema_migrations where version = '223_scale_label_spec_data';
