-- 160: Borrar los paquetes de un producto (a pedido de M2, 26/10/2026: se equivocó con "Envasé" y quería empezar
-- de nuevo). Borra todo lo anotado de paquetes de ese producto en la sucursal y deja de contarlos ahí; los kilos no
-- se tocan. Dueño o administrador. Queda en audit_log cuántos había.

create or replace function public.clear_product_packages(p_branch_id uuid, p_product_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_before integer;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;
  if v_profile.role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador borran paquetes'; end if;
  if not exists (select 1 from public.products where id = p_product_id and company_id = v_profile.company_id) then
    raise exception 'Producto inválido';
  end if;

  select coalesce(sum(delta), 0) into v_before from public.product_package_moves
  where company_id = v_profile.company_id and branch_id = p_branch_id and product_id = p_product_id;

  delete from public.product_package_moves
  where company_id = v_profile.company_id and branch_id = p_branch_id and product_id = p_product_id;

  if not exists (select 1 from public.product_package_moves where product_id = p_product_id) then
    update public.products set track_packages = false where id = p_product_id;
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, p_branch_id, v_user_id, 'product.packages_clear', 'product', p_product_id::text, jsonb_build_object('before', v_before));
end;
$$;

revoke all on function public.clear_product_packages(uuid, uuid) from public, anon;
grant execute on function public.clear_product_packages(uuid, uuid) to authenticated;

insert into public.schema_migrations (version) values ('160_clear_product_packages') on conflict do nothing;
