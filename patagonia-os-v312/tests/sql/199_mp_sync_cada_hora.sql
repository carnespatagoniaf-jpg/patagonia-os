-- Pruebas de la migración 199 (cobros de Mercado Pago cada hora). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- Hay una sola fila, con un token largo y sin dirección hasta que la anota mp-sync.
do $$
declare v record;
begin
  if (select count(*) from mp_sync_schedule) <> 1 then raise exception 'esperaba una fila'; end if;
  select * into v from mp_sync_schedule;
  if length(v.token) < 64 then raise exception 'token corto: %', length(v.token); end if;
  if v.url is not null then raise exception 'la dirección no debería venir cargada'; end if;
end $$;

-- No se puede agregar otra fila.
do $$
begin
  insert into mp_sync_schedule (id) values (2);
  raise exception 'dejó agregar otra fila';
exception when check_violation then null;
end $$;

-- Sin dirección, la tarea no hace nada (y no falla aunque falte pg_net).
select public.mp_sync_tick();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000199a1', 'admin@199'),
  ('00000000-0000-0000-0000-0000000199a2', 'otro@199');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000199a1');

set local role authenticated;

-- Un usuario común no ve el estado ni el token.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000199a2', true);
do $$
begin
  perform public.mp_sync_status();
  raise exception 'un usuario común vio el estado';
exception when others then
  if sqlerrm <> 'No autorizado' then raise; end if;
end $$;
do $$
begin
  if exists (select 1 from mp_sync_schedule) then raise exception 'se ve el token'; end if;
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.mp_sync_tick();
  raise exception 'un usuario pudo disparar la tarea';
exception when insufficient_privilege then null;
end $$;

-- El platform admin ve el estado (sin token).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000199a1', true);
do $$
declare v jsonb;
begin
  v := public.mp_sync_status();
  if v ? 'token' then raise exception 'el estado trae el token'; end if;
  if (v->>'scheduled')::boolean then raise exception 'sin dirección no debería figurar programada'; end if;
end $$;

rollback;
