-- Pruebas de la migración 175 (nadie escribe directo en las tablas). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7501', 'Directo', 9751, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7502', '00000000-0000-0000-0000-0000000c7501', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c7503', 'cajera@directo');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7503', '00000000-0000-0000-0000-0000000c7501', '00000000-0000-0000-0000-0000000c7502', 'Cajera', 'cashier');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c7504', '00000000-0000-0000-0000-0000000c7501', '1', 'Vacío', 'kg', 9000, 15000);

-- Ninguna tabla pública deja escribir a authenticated ni a anon.
do $$
declare v text;
begin
  select string_agg(c.relname, ', ') into v
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
      or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'insert')
      or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'));
  if v is not null then raise exception 'todavía se puede escribir directo en: %', v; end if;
end $$;

-- Una tabla nueva también nace sin permiso de escritura.
create table public.zz_prueba_175 (id int);
do $$
begin
  if has_table_privilege('authenticated', 'public.zz_prueba_175', 'insert') then
    raise exception 'una tabla nueva quedó con permiso de escritura';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7503', true);

-- La cajera ya no puede cambiar el precio directo en la tabla.
do $$
begin
  begin
    update public.products set price_retail = 1 where id = '00000000-0000-0000-0000-0000000c7504';
    raise exception 'pudo cambiar el precio directo';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.treasury_movements (company_id, account_id, direction, amount, movement_type)
    values ('00000000-0000-0000-0000-0000000c7501', gen_random_uuid(), 'in', 1, 'ajuste');
    raise exception 'pudo cargar un movimiento de caja directo';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- Leer sigue andando.
do $$
begin
  if (select count(*) from public.products_with_stock where id = '00000000-0000-0000-0000-0000000c7504') = 0 then
    raise exception 'no puede leer sus productos';
  end if;
end $$;

rollback;
