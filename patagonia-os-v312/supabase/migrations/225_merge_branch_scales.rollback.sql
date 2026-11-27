-- VUELTA ATRÁS de 225_merge_branch_scales.sql: saca las tres funciones y las dos columnas nuevas de scale_profiles.
-- Lo que ya se unió NO se deshace solo: los registros unidos quedan apagados (active = false) y sus referencias
-- (catálogo, papeles, envíos) siguen en el registro que quedó. El detalle de cada unión está en audit_log
-- (action = 'scale.merge'), con los renglones de catálogo que se borraron por repetidos.

drop function if exists public.list_duplicate_scale_candidates(uuid);
drop function if exists public.merge_branch_scales(uuid, text, text[]);
drop function if exists public.mark_scales_distinct(uuid, text[]);

alter table public.scale_profiles drop constraint if exists scale_profiles_merged_into_check;
alter table public.scale_profiles drop column if exists merged_into;
alter table public.scale_profiles drop column if exists not_same_as;

delete from public.schema_migrations where version = '225_merge_branch_scales';
