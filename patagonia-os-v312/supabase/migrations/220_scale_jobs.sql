-- 220: historial de envíos a las balanzas (plan balanzas v2, etapa 0, C18). 26/11/2026.
--
-- Por qué: "Mis balanzas" manda productos a la balanza y, si algo sale mal, solo quedaba la bitácora de ESA
-- computadora (activity-log.ts, localStorage) o un reporte a soporte si alguien lo mandaba. No había forma de saber,
-- desde la base, qué se mandó, cuándo, quién, qué quedó confirmado (releído igual) y qué falló y por qué.
--
-- Qué agrega (aditiva: no cambia ninguna tabla ni función que ya exista):
-- 1. scale_jobs: un renglón por trabajo con una balanza (send = mandar productos, test = prueba, read = lectura):
--    empresa, sucursal, scale_key (la de scale_profiles, sin FK: también se registra la balanza "de esta computadora"
--    que todavía no está en la sucursal), quién, desde dónde (web | connector = futuro Patagonia Scale Connect), estado
--    (running → done | partial | failed), contadores, horarios, versión de la web, código de error y detalle.
-- 2. scale_job_items: el resultado por producto (confirmed | failed | skipped | pending) con su motivo, lo que se mandó
--    (nombre + precio) y lo que se releyó de la balanza.
-- 3. start_scale_job(...) y finish_scale_job(...): la única forma de escribir (migración 175: nada de escrituras
--    directas). Mismos roles que hoy llegan a "Mis balanzas" (Stock y Productos) o al engranaje de Mostrador: dueño,
--    administrador, encargado, producción, cajero y solo lectura. El contador no.
--
-- Lectura: RLS por empresa (company_id = current_company_id()), como el resto. Sin políticas de escritura.
-- Topes: 10.000 productos por trabajo, 300 trabajos por sucursal por día, textos y jsonb acotados.
-- La web ignora en silencio si esta migración todavía no está (función inexistente): el envío nunca se frena.
-- Vuelta atrás: 220_scale_jobs.rollback.sql.

-- ------------------------------------------------------------------------------------------------- tablas
create table if not exists public.scale_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  scale_key text not null check (length(scale_key) between 1 and 120),
  kind text not null check (kind in ('send', 'test', 'read')),
  created_by uuid references auth.users(id) on delete set null,
  source text not null default 'web' check (source in ('web', 'connector')),
  status text not null default 'running' check (status in ('running', 'done', 'partial', 'failed')),
  requested_count integer not null default 0 check (requested_count between 0 and 10000),
  confirmed_count integer not null default 0 check (confirmed_count between 0 and 10000),
  failed_count integer not null default 0 check (failed_count between 0 and 10000),
  skipped_count integer not null default 0 check (skipped_count between 0 and 10000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  app_version text check (app_version is null or length(app_version) <= 80),
  error_code text check (error_code is null or length(error_code) <= 80),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  check ((status = 'running') = (finished_at is null))
);
create index if not exists scale_jobs_branch_started_idx on public.scale_jobs (company_id, branch_id, started_at desc);
create index if not exists scale_jobs_scale_started_idx on public.scale_jobs (company_id, branch_id, scale_key, started_at desc);

create table if not exists public.scale_job_items (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.scale_jobs(id) on delete cascade,
  -- Repetida del trabajo para que la RLS no necesite un join.
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  plu text check (plu is null or length(plu) <= 40),
  action text not null check (action in ('write', 'replace', 'delete', 'read', 'verify')),
  status text not null check (status in ('confirmed', 'failed', 'skipped', 'pending')),
  reason text check (reason is null or length(reason) <= 300),
  sent jsonb check (sent is null or jsonb_typeof(sent) = 'object'),
  read_back jsonb check (read_back is null or jsonb_typeof(read_back) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists scale_job_items_job_idx on public.scale_job_items (job_id);
create index if not exists scale_job_items_company_idx on public.scale_job_items (company_id);
create index if not exists scale_job_items_product_idx on public.scale_job_items (product_id) where product_id is not null;

alter table public.scale_jobs enable row level security;
alter table public.scale_job_items enable row level security;

drop policy if exists scale_jobs_read on public.scale_jobs;
create policy scale_jobs_read on public.scale_jobs for select to authenticated using (company_id = public.current_company_id());
drop policy if exists scale_job_items_read on public.scale_job_items;
create policy scale_job_items_read on public.scale_job_items for select to authenticated using (company_id = public.current_company_id());

-- Solo lectura desde la API (175). Explícito, además de los permisos por defecto.
revoke all on table public.scale_jobs, public.scale_job_items from anon;
revoke insert, update, delete, truncate, references, trigger on table public.scale_jobs, public.scale_job_items from authenticated;
grant select on table public.scale_jobs, public.scale_job_items to authenticated;

drop trigger if exists zz_accountant_readonly on public.scale_jobs;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_jobs
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.scale_job_items;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_job_items
  for each statement execute function public.accountant_readonly_guard();

-- ------------------------------------------------------------------------------------------------- start
create or replace function public.start_scale_job(
  p_branch_id uuid,
  p_scale_key text,
  p_kind text,
  p_source text default 'web',
  p_requested integer default 0,
  p_app_version text default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_id uuid;
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier', 'readonly']::text[]);
  if v_user is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company)
     or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;
  if p_scale_key is null or length(btrim(p_scale_key)) = 0 or length(p_scale_key) > 120 then raise exception 'Balanza inválida'; end if;
  if p_kind is null or p_kind not in ('send', 'test', 'read') then raise exception 'Tipo de trabajo inválido'; end if;
  if p_source is null or p_source not in ('web', 'connector') then raise exception 'Origen inválido'; end if;
  if p_requested is null or p_requested < 0 or p_requested > 10000 then raise exception 'Hasta 10.000 productos por envío'; end if;
  if p_detail is not null and (jsonb_typeof(p_detail) <> 'object' or length(p_detail::text) > 32768) then raise exception 'Detalle inválido'; end if;
  -- Un envío es algo que hace una persona: 300 por sucursal por día es muchísimo (frena un bucle, no a nadie).
  if (select count(*) from public.scale_jobs where company_id = v_company and branch_id = p_branch_id and started_at > now() - interval '1 day') >= 300 then
    raise exception 'Demasiados envíos registrados hoy en esta sucursal';
  end if;

  insert into public.scale_jobs (company_id, branch_id, scale_key, kind, created_by, source, requested_count, app_version, detail)
  values (v_company, p_branch_id, p_scale_key, p_kind, v_user, p_source, p_requested, left(p_app_version, 80), coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale_job.start', 'scale_job', v_id::text,
          jsonb_build_object('scale_key', p_scale_key, 'kind', p_kind, 'source', p_source, 'requested', p_requested));
  return v_id;
end;
$$;

-- ------------------------------------------------------------------------------------------------- finish
-- p_counters: {"requested", "confirmed", "failed", "skipped"} (los que falten salen de contar p_items).
-- p_items: [{"product_id", "plu", "action", "status", "reason", "sent", "read_back"}], hasta 10.000.
create or replace function public.finish_scale_job(
  p_job_id uuid,
  p_status text,
  p_counters jsonb default '{}'::jsonb,
  p_items jsonb default '[]'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_job public.scale_jobs%rowtype;
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_counters jsonb := coalesce(p_counters, '{}'::jsonb);
  v_n integer;
  v_bad integer;
  v_requested integer;
  v_confirmed integer;
  v_failed integer;
  v_skipped integer;
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier', 'readonly']::text[]);
  if v_user is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;

  select * into v_job from public.scale_jobs where id = p_job_id and company_id = v_company for update;
  if v_job.id is null then raise exception 'Envío inexistente'; end if;
  if not public.my_branch_allowed(v_job.branch_id) then raise exception 'Sucursal inválida'; end if;
  if v_job.status <> 'running' then raise exception 'Ese envío ya está cerrado'; end if;
  if p_status is null or p_status not in ('done', 'partial', 'failed') then raise exception 'Estado inválido'; end if;
  if jsonb_typeof(v_counters) <> 'object' then raise exception 'Contadores inválidos'; end if;
  if jsonb_typeof(v_items) <> 'array' then raise exception 'Productos inválidos'; end if;
  v_n := jsonb_array_length(v_items);
  if v_n > 10000 then raise exception 'Hasta 10.000 productos por envío'; end if;

  -- Cada producto: acción y estado conocidos, textos cortos, sent/read_back objetos chicos, product_id de ESTA empresa.
  select count(*) into v_bad
  from jsonb_array_elements(v_items) e(x)
  where jsonb_typeof(e.x) <> 'object'
     or coalesce(e.x ->> 'action', '') not in ('write', 'replace', 'delete', 'read', 'verify')
     or coalesce(e.x ->> 'status', '') not in ('confirmed', 'failed', 'skipped', 'pending')
     or length(coalesce(e.x ->> 'plu', '')) > 40
     or (e.x -> 'sent' is not null and jsonb_typeof(e.x -> 'sent') not in ('object', 'null'))
     or (e.x -> 'read_back' is not null and jsonb_typeof(e.x -> 'read_back') not in ('object', 'null'))
     or length(coalesce(e.x ->> 'sent', '')) > 2000
     or length(coalesce(e.x ->> 'read_back', '')) > 2000
     or (coalesce(e.x ->> 'product_id', '') <> '' and (
          (e.x ->> 'product_id') !~ '^[0-9a-fA-F-]{36}$'
          or not exists (select 1 from public.products p where p.id = (e.x ->> 'product_id')::uuid and p.company_id = v_company)));
  if v_bad > 0 then raise exception 'Hay % productos con datos inválidos', v_bad; end if;

  insert into public.scale_job_items (job_id, company_id, product_id, plu, action, status, reason, sent, read_back)
  select v_job.id, v_company,
         nullif(e.x ->> 'product_id', '')::uuid,
         nullif(e.x ->> 'plu', ''),
         e.x ->> 'action',
         e.x ->> 'status',
         left(nullif(e.x ->> 'reason', ''), 300),
         case when jsonb_typeof(e.x -> 'sent') = 'object' then e.x -> 'sent' end,
         case when jsonb_typeof(e.x -> 'read_back') = 'object' then e.x -> 'read_back' end
  from jsonb_array_elements(v_items) e(x);

  v_requested := least(greatest(coalesce((v_counters ->> 'requested')::integer, v_job.requested_count, v_n), 0), 10000);
  v_confirmed := least(greatest(coalesce((v_counters ->> 'confirmed')::integer, (select count(*) from jsonb_array_elements(v_items) e(x) where e.x ->> 'status' = 'confirmed')::integer), 0), 10000);
  v_failed := least(greatest(coalesce((v_counters ->> 'failed')::integer, (select count(*) from jsonb_array_elements(v_items) e(x) where e.x ->> 'status' = 'failed')::integer), 0), 10000);
  v_skipped := least(greatest(coalesce((v_counters ->> 'skipped')::integer, (select count(*) from jsonb_array_elements(v_items) e(x) where e.x ->> 'status' = 'skipped')::integer), 0), 10000);

  update public.scale_jobs
     set status = p_status,
         finished_at = now(),
         requested_count = v_requested,
         confirmed_count = v_confirmed,
         failed_count = v_failed,
         skipped_count = v_skipped,
         error_code = left(nullif(btrim(p_error), ''), 80)
   where id = v_job.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_job.branch_id, v_user, 'scale_job.finish', 'scale_job', v_job.id::text,
          jsonb_build_object('scale_key', v_job.scale_key, 'status', p_status, 'requested', v_requested, 'confirmed', v_confirmed,
                             'failed', v_failed, 'skipped', v_skipped, 'items', v_n, 'error', left(nullif(btrim(p_error), ''), 80)));

  return jsonb_build_object('id', v_job.id, 'status', p_status, 'items', v_n, 'requested', v_requested, 'confirmed', v_confirmed, 'failed', v_failed, 'skipped', v_skipped);
end;
$$;

revoke all on function public.start_scale_job(uuid, text, text, text, integer, text, jsonb) from public, anon;
revoke all on function public.finish_scale_job(uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.start_scale_job(uuid, text, text, text, integer, text, jsonb) to authenticated;
grant execute on function public.finish_scale_job(uuid, text, jsonb, jsonb, text) to authenticated;

insert into public.schema_migrations (version) values ('220_scale_jobs') on conflict do nothing;
