-- Número de cliente (pedido del dueño, 2026-10-05: "estaría bueno
-- identificarlos con un número, así en el contacto del celular les pongo el
-- mismo y sé quiénes son fácil").
--
-- Un número correlativo por empresa (1, 2, 3...), asignado solo al crear el
-- cliente y que no cambia nunca (aunque se renombre o se dé de baja), así el
-- que guardaste en el celular sigue sirviendo. Los clientes que ya existían
-- se numeran por orden de alta. Disponible en todos los planes (los clientes
-- ya están gateados por su propio plan).
--
-- Lo asigna un trigger, así cubre TODAS las altas (create_customer,
-- importar datos, create_client) sin tocar esas funciones.

alter table public.customers add column if not exists number integer;

with numbered as (
  select id, row_number() over (partition by company_id order by created_at, id) as n
  from public.customers
  where number is null
)
update public.customers c
set number = numbered.n + coalesce((select max(number) from public.customers x where x.company_id = c.company_id), 0)
from numbered
where numbered.id = c.id;

create or replace function public.customers_assign_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.number is null then
    -- Un lock por empresa para que dos altas al mismo tiempo no saquen el
    -- mismo número.
    perform pg_advisory_xact_lock(hashtext('customers_number:' || new.company_id::text));
    select coalesce(max(number), 0) + 1 into new.number
    from public.customers
    where company_id = new.company_id;
  end if;
  return new;
end;
$$;

revoke all on function public.customers_assign_number() from public, anon, authenticated;

drop trigger if exists customers_assign_number on public.customers;
create trigger customers_assign_number
before insert on public.customers
for each row execute function public.customers_assign_number();

-- El número no se cambia una vez asignado.
create or replace function public.customers_keep_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.number := old.number;
  return new;
end;
$$;

revoke all on function public.customers_keep_number() from public, anon, authenticated;

drop trigger if exists customers_keep_number on public.customers;
create trigger customers_keep_number
before update of number on public.customers
for each row execute function public.customers_keep_number();

alter table public.customers alter column number set not null;
create unique index if not exists customers_company_number_key on public.customers (company_id, number);

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('109_customer_number') on conflict do nothing;
