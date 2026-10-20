-- Productos: eliminar y dar de baja desde Stock (2026-10-20, pedido del dueño
-- hablando con Martínez: "tendríamos que poder eliminarlo", para todos).
--
-- delete_product: borra SOLO un producto sin historia (nunca vendido, comprado,
-- despostado, en una receta ni con movimientos de stock). Ninguna tabla que
-- apunta a products borra en cascada (verificado en prod: todas son NO ACTION
-- o SET NULL), así que si tiene historia el DELETE falla por la clave foránea y
-- se le dice a la persona que lo dé de baja. Los tres SET NULL (presentaciones,
-- movimientos "vía" una presentación y anulaciones de tickets de balanza) se
-- chequean antes, para no perder ese vínculo en silencio.
--
-- set_product_active: dar de baja / reactivar sin pasar por Editar.
-- Roles: dueño, administrador y encargado (los mismos que manejan Stock).

create or replace function public.delete_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_product public.products%rowtype;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado elimina productos';
  end if;

  select * into v_product from public.products where id = p_product_id and company_id = v_company_id for update;
  if v_product.id is null then
    raise exception 'Producto inválido';
  end if;

  if exists (select 1 from public.products where stock_source_id = v_product.id)
     or exists (select 1 from public.inventory_movements where via_product_id = v_product.id)
     or exists (select 1 from public.scale_ticket_voids where product_id = v_product.id) then
    raise exception 'Este producto ya se usó (tiene presentaciones o movimientos). No se puede eliminar: dalo de baja.';
  end if;

  begin
    delete from public.products where id = v_product.id;
  exception when foreign_key_violation then
    raise exception 'Este producto ya tiene ventas, compras o movimientos de stock. No se puede eliminar para no perder esa historia: dalo de baja (deja de aparecer para vender).';
  end;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, v_user_id, 'product.delete', 'product', v_product.id::text,
          jsonb_build_object('code', v_product.code, 'name', v_product.name, 'unit', v_product.unit, 'price_retail', v_product.price_retail));
end;
$$;
revoke all on function public.delete_product(uuid) from public, anon;
grant execute on function public.delete_product(uuid) to authenticated;

create or replace function public.set_product_active(p_product_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado da de baja productos';
  end if;
  update public.products set active = coalesce(p_active, true)
  where id = p_product_id and company_id = v_company_id
  returning name into v_name;
  if v_name is null then
    raise exception 'Producto inválido';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, case when p_active then 'product.reactivate' else 'product.deactivate' end, 'product', p_product_id::text,
          jsonb_build_object('name', v_name, 'active', p_active));
end;
$$;
revoke all on function public.set_product_active(uuid, boolean) from public, anon;
grant execute on function public.set_product_active(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('139_product_delete_and_active') on conflict do nothing;
