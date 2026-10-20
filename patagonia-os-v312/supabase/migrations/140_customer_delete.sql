-- Clientes: botón "Eliminar cliente" (2026-10-20, pedido del dueño con Martínez:
-- "no se puede eliminar ni un cliente"). Hasta ahora solo existía, escondido,
-- Editar → "Inactivo (eliminado)".
--
-- delete_customer: si el cliente nunca tuvo ventas ni pagos, se borra del todo.
-- Si tiene historia, NO se borra (las ventas y pagos apuntan a él y no deben
-- perderse): queda inactivo (sale de la lista) y se devuelve 'deactivated'.
-- Verificado en prod: customer_charges y customer_payments son NO ACTION; la
-- única en cascada es bank_reconciliation_rules (una regla de conciliación de
-- ese cliente, que sin cliente no sirve).

create or replace function public.delete_customer(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_customer public.customers%rowtype;
  v_result text;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador elimina clientes';
  end if;

  select * into v_customer from public.customers where id = p_customer_id and company_id = v_company_id for update;
  if v_customer.id is null then
    raise exception 'Cliente inválido';
  end if;

  if exists (select 1 from public.customer_charges where customer_id = v_customer.id)
     or exists (select 1 from public.customer_payments where customer_id = v_customer.id) then
    update public.customers set active = false where id = v_customer.id;
    v_result := 'deactivated';
  else
    delete from public.customers where id = v_customer.id;
    v_result := 'deleted';
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, v_user_id, 'customer.' || v_result, 'customer', v_customer.id::text,
          jsonb_build_object('name', v_customer.name, 'number', v_customer.number));
  return v_result;
end;
$$;
revoke all on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_customer(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('140_customer_delete') on conflict do nothing;
