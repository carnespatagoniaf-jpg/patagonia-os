-- El dueño pidió poder eliminar de verdad un proveedor (ej. uno de
-- prueba/duplicado), no solo desactivarlo (update_supplier,
-- 056_update_supplier.sql). Ninguna FK hacia suppliers tiene "on delete
-- cascade" (purchases, supplier_payments, shift_outflows, carcass_batches
-- -- 007/008/020) así que Postgres ya rechaza solo el borrado si el
-- proveedor tiene compras/pagos reales -- acá solo se traduce ese
-- rechazo a un mensaje claro, mismo patrón que delete-staff-user.
create or replace function public.delete_supplier(p_supplier_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select name into v_name
  from public.suppliers
  where id = p_supplier_id and company_id = v_company_id
  for update;

  if v_name is null then
    raise exception 'Proveedor inválido';
  end if;

  begin
    delete from public.suppliers where id = p_supplier_id;
  exception when foreign_key_violation then
    raise exception 'Este proveedor ya tiene compras o pagos registrados y no se puede eliminar del todo -- marcalo como inactivo en su lugar.';
  end;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, old_data
  ) values (
    v_company_id, v_user_id, 'supplier.delete', 'supplier', p_supplier_id::text,
    jsonb_build_object('name', v_name)
  );
end;
$$;

revoke all on function public.delete_supplier(uuid) from public;
grant execute on function public.delete_supplier(uuid) to authenticated;
