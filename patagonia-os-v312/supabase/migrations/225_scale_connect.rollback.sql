-- VUELTA ATRÁS de 225_scale_connect.sql. Borra la vinculación de Scale Connect y la cola de trabajos en la nube.
-- scale_jobs (220) vuelve a como estaba: los trabajos que quedaron en cola pasan a fallidos ('sin_scale_connect')
-- para cumplir los checks de la 220, y se pierden payload/connector_id/claimed_at/progreso.
-- Ojo: todas las PC vinculadas quedan desvinculadas (hay que volver a vincularlas si se reaplica la 225).

update public.scale_jobs set status = 'failed', finished_at = now(), error_code = 'sin_scale_connect'
 where status = 'queued';

drop function if exists public.scale_connector_config(uuid, text);
drop function if exists public.scale_connector_finish_job(uuid, text, uuid, text, jsonb, jsonb, text);
drop function if exists public.scale_connector_job_progress(uuid, text, uuid, integer, integer, integer, text, jsonb);
drop function if exists public.scale_connector_claim_job(uuid, text);
drop function if exists public.scale_connector_heartbeat(uuid, text, text, jsonb);
drop function if exists public.scale_connector_redeem_pairing(text, text, text, text, text, text, uuid, boolean);
drop function if exists public.queue_scale_job(text, text, jsonb, uuid, uuid);
drop function if exists public.revoke_scale_connector(uuid);
drop function if exists public.rename_scale_connector(uuid, text);
drop function if exists public.list_scale_connectors();
drop function if exists public.create_scale_connector_pairing(uuid);
drop function if exists public.scale_job_append_items(uuid, uuid, jsonb);
drop function if exists public.scale_connector_can_take(public.scale_connectors, public.scale_jobs);
drop function if exists public.scale_connector_auth(uuid, text);

drop index if exists public.scale_jobs_queue_idx;
drop index if exists public.scale_jobs_connector_idx;
alter table public.scale_jobs drop constraint if exists scale_jobs_progress_check;
alter table public.scale_jobs drop constraint if exists scale_jobs_payload_check;
alter table public.scale_jobs drop constraint if exists scale_jobs_finished_check;
alter table public.scale_jobs drop constraint if exists scale_jobs_status_check;
alter table public.scale_jobs add constraint scale_jobs_status_check check (status in ('running', 'done', 'partial', 'failed'));
alter table public.scale_jobs add constraint scale_jobs_check check ((status = 'running') = (finished_at is null));
alter table public.scale_jobs drop column if exists progress_seq;
alter table public.scale_jobs drop column if exists progress_at;
alter table public.scale_jobs drop column if exists progress;
alter table public.scale_jobs drop column if exists claimed_at;
alter table public.scale_jobs drop column if exists payload;
alter table public.scale_jobs drop column if exists connector_id;

drop table if exists public.scale_connector_pair_failures;
drop table if exists public.scale_connector_pairings;
drop table if exists public.scale_connectors;

drop function if exists public.scale_connect_normalize_code(text);
drop function if exists public.scale_connect_new_code();
drop function if exists public.scale_connect_sha256(text);

delete from public.schema_migrations where version = '225_scale_connect';
