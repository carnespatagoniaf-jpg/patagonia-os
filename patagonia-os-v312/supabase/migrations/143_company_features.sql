-- Pantallas a pedido de un cliente (2026-10-21, Martínez): companies.features
-- es la lista de pantallas extra que ve esa empresa, además de lo que le da su
-- plan y su rol. La web la lee en AuthProvider (permissions.ts:
-- PAGE_REQUIRED_FEATURE). Hoy:
--   'cuentas' -> Finanzas → "Reporte de cuentas" (lo que te deben los clientes
--                y lo que le debés a los proveedores, en total y por cada uno)
--   'gastos'  -> Finanzas → "Gastos" (gastos operativos por período y categoría;
--                usa register_treasury_expense / delete_treasury_expense, sin
--                funciones nuevas)
-- Solo lee datos que la empresa ya ve (views con filtro por empresa), así que
-- no hay funciones nuevas ni cambios de RLS. Se activa a mano:
--   update public.companies set features = array['cuentas','gastos'] where id = '<empresa>';

alter table public.companies add column if not exists features text[] not null default '{}';

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('143_company_features') on conflict do nothing;
