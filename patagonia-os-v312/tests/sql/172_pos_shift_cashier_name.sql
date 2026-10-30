-- Pruebas de la migración 172 (nombre de quien atiende al abrir la caja). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7201', 'Sin PIN', 9721, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7202', '00000000-0000-0000-0000-0000000c7201', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c7203', 'duenio@sinpin');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7203', '00000000-0000-0000-0000-0000000c7201', '00000000-0000-0000-0000-0000000c7202', 'Usuario de la PC', 'owner');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7203', true);

do $$
declare r jsonb; v text; closes jsonb;
begin
  -- Sin PIN: se guarda el nombre escrito (espacios de más se limpian).
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7202', 1000, null, null, '  Marta   Gómez ');
  if r ->> 'cashier_name' is distinct from 'Marta Gómez' then raise exception 'nombre: dio %', r; end if;
  select cashier_name into v from pos_shifts where id = (r ->> 'id')::uuid;
  if v is distinct from 'Marta Gómez' then raise exception 'no se guardó el nombre: %', v; end if;
  closes := public.list_pos_shift_closes('00000000-0000-0000-0000-0000000c7202', 30);
  if closes -> 0 ->> 'cashier_name' is distinct from 'Marta Gómez' then raise exception 'Control de caja: %', closes; end if;
end $$;

reset role;
update pos_shifts set status = 'closed', closed_at = now() where branch_id = '00000000-0000-0000-0000-0000000c7202';
set local role authenticated;

do $$
declare r jsonb; closes jsonb;
begin
  -- Como antes (2 argumentos, pestaña vieja) y sin nombre: aparece el usuario de la PC.
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7202', 0);
  if r ->> 'cashier_name' is not null then raise exception 'sin nombre debía quedar vacío: %', r; end if;
  closes := public.list_pos_shift_closes('00000000-0000-0000-0000-0000000c7202', 30);
  -- (dentro de la prueba todos los turnos tienen la misma hora: se busca el abierto)
  if (select e ->> 'cashier_name' from jsonb_array_elements(closes) e where e ->> 'status' = 'open') is distinct from 'Usuario de la PC' then
    raise exception 'sin nombre: %', closes;
  end if;
  -- Ya abierta: devuelve la misma.
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7202', 0, null, null, 'Otra');
  if (r ->> 'already_open')::boolean is not true then raise exception 'abrió dos turnos'; end if;
end $$;

-- Un nombre de más de 60 letras se corta, no rompe.
reset role;
update pos_shifts set status = 'closed', closed_at = now() where branch_id = '00000000-0000-0000-0000-0000000c7202';
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7202', 0, null, null, repeat('a', 80));
  if length(r ->> 'cashier_name') <> 60 then raise exception 'no cortó el nombre: %', r; end if;
end $$;

-- Reportes → por cajero usa el nombre de la caja.
reset role;
do $$
begin
  if position('sh.cashier_name' in pg_get_functiondef('public.sales_activity_report'::regproc)) = 0 then
    raise exception 'sales_activity_report no usa el nombre de la caja';
  end if;
end $$;

rollback;
