-- Permite a un platform admin borrar de verdad un cliente (no solo
-- desactivarlo) -- pensado para una empresa que se dio de alta por error o
-- de prueba, nunca usada de verdad. NINGUNA tabla de negocio tiene
-- "on delete cascade" desde companies (a propósito, ver 001_core.sql y
-- siguientes) -- eso ya protege contra un borrado accidental de datos
-- reales: si cualquiera de esas tablas tiene una fila para esta empresa,
-- Postgres rechaza el delete.
--
-- Esta función va un paso más allá: en vez de intentar el delete a ciegas y
-- confiar en que el error de Postgres frene a tiempo (lo que podría dejar
-- a mitad de camino un borrado de perfiles/usuarios ya hecho), primero
-- CHEQUEA sin tocar nada que ninguna tabla real tenga datos de esta
-- empresa. La lista de tablas a chequear se arma dinámicamente leyendo
-- information_schema (todas las que tengan una FK a companies(id)), no
-- está hardcodeada -- así, si mañana se agrega una tabla nueva con
-- company_id, este chequeo la cubre solo, sin tener que acordarse de
-- actualizar esta función.
--
-- Se excluyen del chequeo "branches", "profiles" y "audit_log" -- son las
-- únicas tres tablas que SIEMPRE tienen al menos una fila para cualquier
-- empresa (la sucursal inicial, el dueño, el registro de alta), y son
-- justamente las que esta función borra como parte del proceso.
--
-- Devuelve los ids de auth.users de los perfiles borrados -- borrar el
-- login de verdad requiere el Admin API de Supabase (mismo motivo que
-- create-client/delete-staff-user), así que eso lo hace la Edge Function
-- "delete-client" después de que este paso (la parte de base de datos)
-- haya terminado bien.
create or replace function public.delete_company_if_unused(p_company_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table record;
  v_exists boolean;
  v_user_ids uuid[];
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa inválida';
  end if;

  for v_table in
    select distinct tc.table_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    join information_schema.referential_constraints rc
      on tc.constraint_name = rc.constraint_name and tc.table_schema = rc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_name = 'companies'
      and ccu.column_name = 'id'
      and tc.table_schema = 'public'
      and tc.table_name not in ('branches', 'profiles', 'audit_log')
  loop
    execute format('select exists(select 1 from public.%I where company_id = $1)', v_table.table_name)
      into v_exists
      using p_company_id;
    if v_exists then
      raise exception 'Esta empresa ya tiene datos cargados (tabla "%") -- no se puede borrar directamente, desactivala en su lugar.', v_table.table_name;
    end if;
  end loop;

  select array_agg(id) into v_user_ids from public.profiles where company_id = p_company_id;

  delete from public.audit_log where company_id = p_company_id;
  delete from public.profiles where company_id = p_company_id;
  delete from public.branches where company_id = p_company_id;
  delete from public.companies where id = p_company_id;

  return coalesce(v_user_ids, array[]::uuid[]);
end;
$$;

revoke all on function public.delete_company_if_unused(uuid) from public;
grant execute on function public.delete_company_if_unused(uuid) to authenticated;
