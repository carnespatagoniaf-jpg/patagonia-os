-- VUELTA ATRÁS de 220_scale_jobs.sql. Borra el historial de envíos a las balanzas (tablas y funciones nuevas).
-- No toca nada que existiera antes: la 220 es aditiva. La web sigue andando (ignora la función inexistente).
-- Ojo: se pierde el historial guardado. Si hace falta conservarlo, exportar antes scale_jobs y scale_job_items.

drop function if exists public.finish_scale_job(uuid, text, jsonb, jsonb, text);
drop function if exists public.start_scale_job(uuid, text, text, text, integer, text, jsonb);
drop table if exists public.scale_job_items;
drop table if exists public.scale_jobs;

delete from public.schema_migrations where version = '220_scale_jobs';
