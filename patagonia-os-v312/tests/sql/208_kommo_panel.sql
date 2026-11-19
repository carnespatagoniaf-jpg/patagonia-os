-- Pruebas de la migración 208 (Kommo en el panel). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c2081', 'cualquiera@x'),
  ('00000000-0000-0000-0000-0000000c2082', 'admin@patagonia');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000c2082');

update kommo_sync_schedule set url = 'https://x/functions/v1/kommo-sync', subdomain = 'carnes',
  last_run_at = now(), last_result = '{"contacts":1}'::jsonb;
select public.kommo_lead_event(92081, 'Ana', null, true, 'hola');

-- Alguien que no es administrador no ve nada.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2081', true);
do $$
begin
  if exists (select 1 from public.kommo_sync_status()) then raise exception 'un no-admin vio el estado'; end if;
  if exists (select 1 from public.list_platform_leads()) then raise exception 'un no-admin vio interesados'; end if;
end $$;

-- El administrador ve el estado (sin token ni dirección) y el id de Kommo del contacto.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2082', true);
do $$
declare v record;
begin
  select * into v from public.kommo_sync_status();
  if not v.configured or v.subdomain <> 'carnes' or v.last_run_at is null or v.last_result ->> 'contacts' <> '1' then
    raise exception 'estado: %', row_to_json(v);
  end if;
  if (select kommo_contact_id from public.list_platform_leads() where business_name = 'Ana') <> 92081 then
    raise exception 'la lista no trae kommo_contact_id';
  end if;
end $$;

-- anon no puede llamarla.
set local role anon;
do $$
begin
  perform public.kommo_sync_status();
  raise exception 'anon pudo llamar kommo_sync_status';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
