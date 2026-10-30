-- Pruebas de la migración 181 ("Primeros pasos"). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c8101', 'Nuevo', 9811, 'estandar', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c8102', '00000000-0000-0000-0000-0000000c8101', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c8103', 'duenio@nuevo');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c8103', '00000000-0000-0000-0000-0000000c8101', '00000000-0000-0000-0000-0000000c8102', 'Dueño', 'owner');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8103', true);

do $$
declare r jsonb;
begin
  r := public.onboarding_status();
  if (r ->> 'products')::int <> 0 or (r ->> 'stock_loaded')::boolean or (r ->> 'sales')::int <> 0 then
    raise exception 'un cliente nuevo no arranca en cero: %', r;
  end if;
  insert into products (company_id, code, name, unit, cost, price_retail)
  select '00000000-0000-0000-0000-0000000c8101', g::text, 'P' || g, 'kg', 1, 2 from generate_series(1, 6) g;
  r := public.onboarding_status();
  if (r ->> 'products')::int <> 6 then raise exception 'no cuenta los productos: %', r; end if;
end $$;

rollback;
