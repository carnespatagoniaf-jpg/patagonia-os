-- Pruebas de la migración 206 (Kommo por sincronización periódica). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

do $$
declare v record;
begin
  if (select count(*) from kommo_sync_schedule) <> 1 then raise exception 'esperaba una fila'; end if;
  select * into v from kommo_sync_schedule;
  if length(v.token) < 64 then raise exception 'token corto: %', length(v.token); end if;
  if v.url is not null or v.contacts_since is not null or v.events_since is not null then
    raise exception 'debería arrancar vacía: %', row_to_json(v);
  end if;
end $$;

do $$
begin
  insert into kommo_sync_schedule (id) values (2);
  raise exception 'dejó agregar otra fila';
exception when check_violation then null;
end $$;

-- Sin dirección, la tarea no hace nada (y no falla aunque falte pg_net).
select public.kommo_sync_tick();

-- La web no la puede llamar ni leer la tabla.
set local role authenticated;
do $$
begin
  perform public.kommo_sync_tick();
  raise exception 'authenticated pudo llamar kommo_sync_tick';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  if exists (select 1 from kommo_sync_schedule) then raise exception 'authenticated ve el token'; end if;
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
