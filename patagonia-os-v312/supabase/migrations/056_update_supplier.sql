-- No existía forma de editar ni "borrar" un proveedor -- solo crear.
-- Un proveedor real tiene compras y pagos enganchados (cuenta corriente),
-- así que hard-delete rompería esa historia; en cambio, igual que
-- empleados/sucursales/productos, se desactiva (active = false) y deja de
-- aparecer en la lista y en el selector de nuevas compras, sin perder el
-- historial ya cargado.
create or replace function public.update_supplier(
  p_supplier_id uuid,
  p_name text,
  p_category text,
  p_phone text default null,
  p_notes text default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre del proveedor es obligatorio';
  end if;

  if not exists (
    select 1 from public.suppliers where id = p_supplier_id and company_id = v_company_id for update
  ) then
    raise exception 'Proveedor inválido';
  end if;

  update public.suppliers
  set name = trim(p_name),
      category = coalesce(nullif(trim(p_category), ''), 'general'),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      active = p_active
  where id = p_supplier_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'supplier.update', 'supplier', p_supplier_id::text,
    jsonb_build_object('name', p_name, 'category', p_category, 'active', p_active)
  );

  return jsonb_build_object('id', p_supplier_id);
end;
$$;

revoke all on function public.update_supplier(uuid,text,text,text,text,boolean) from public;
grant execute on function public.update_supplier(uuid,text,text,text,text,boolean) to authenticated;
