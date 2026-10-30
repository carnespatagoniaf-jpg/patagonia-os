-- Pruebas de la migración 180 ("Para revisar hoy", solo administradores de Patagonia). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c8001', 'Revisar', 9801, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c8002', '00000000-0000-0000-0000-0000000c8001', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c8003', 'duenio@revisar'),
  ('00000000-0000-0000-0000-0000000c8004', 'admin@patagonia');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c8003', '00000000-0000-0000-0000-0000000c8001', '00000000-0000-0000-0000-0000000c8002', 'Dueño', 'owner');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000c8004');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c8005', '00000000-0000-0000-0000-0000000c8001', '1', 'Vacío', 'kg', 9000, 8000);

-- Un dueño de negocio no la ve.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8003', true);
do $$
begin
  perform public.platform_daily_checks();
  raise exception 'un dueño vio la revisión de la plataforma';
exception when others then
  if sqlerrm = 'un dueño vio la revisión de la plataforma' then raise; end if;
end $$;

-- El administrador de Patagonia ve el cliente con su precio bajo el costo y sin ventas.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8004', true);
do $$
declare r jsonb; c jsonb;
begin
  r := public.platform_daily_checks();
  select e into c from jsonb_array_elements(r) e where e ->> 'id' = '00000000-0000-0000-0000-0000000c8001';
  if c is null then raise exception 'no aparece el cliente'; end if;
  if (c ->> 'below_cost')::int <> 1 then raise exception 'precio bajo costo: %', c; end if;
end $$;

rollback;
