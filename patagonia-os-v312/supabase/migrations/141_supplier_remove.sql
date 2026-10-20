-- Proveedores: "Borrar" sin cartel de error (2026-10-20, pedido del dueño con
-- Martínez). delete_supplier (068) fallaba con un aviso si el proveedor tenía
-- compras o pagos. remove_supplier hace lo mismo que delete_customer (140): sin
-- historia se borra; con historia queda inactivo (sale de la lista, se guardan
-- sus compras y pagos) y devuelve 'deactivated'. Ninguna FK hacia suppliers es
-- en cascada (verificado en prod), así que el DELETE nunca se lleva historia.
-- delete_supplier queda como estaba para quien todavía lo llame.

create or replace function public.remove_supplier(p_supplier_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_name text;
  v_result text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado borra proveedores';
  end if;

  select name into v_name from public.suppliers where id = p_supplier_id and company_id = v_company_id for update;
  if v_name is null then
    raise exception 'Proveedor inválido';
  end if;

  begin
    delete from public.suppliers where id = p_supplier_id;
    v_result := 'deleted';
  exception when foreign_key_violation then
    update public.suppliers set active = false where id = p_supplier_id;
    v_result := 'deactivated';
  end;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, v_user_id, 'supplier.' || v_result, 'supplier', p_supplier_id::text, jsonb_build_object('name', v_name));
  return v_result;
end;
$$;
revoke all on function public.remove_supplier(uuid) from public, anon;
grant execute on function public.remove_supplier(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('141_supplier_remove') on conflict do nothing;
