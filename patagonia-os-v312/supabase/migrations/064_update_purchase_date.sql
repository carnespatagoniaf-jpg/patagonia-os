-- El dueño pidió poder corregir la fecha de una compra ya cargada (cargó
-- una del cerdo en septiembre cuando era agosto) -- hoy solo se puede
-- editar cantidad/precio de cada ítem (update_purchase_item,
-- 019_product_costs.sql) o anular la compra entera, no corregir un dato
-- simple como la fecha. No toca stock ni el total, solo purchases.purchase_date
-- -- pero sí importa para Rentabilidad, que filtra compras por
-- purchase_date between periodo (017_profitability.sql).
create or replace function public.update_purchase_date(
  p_purchase_id uuid,
  p_purchase_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_purchase public.purchases%rowtype;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select profiles.company_id into v_company_id
  from public.profiles
  where profiles.id = v_user_id and profiles.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_purchase_date is null then
    raise exception 'La fecha es obligatoria';
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Compra inválida';
  end if;

  update public.purchases
  set purchase_date = p_purchase_date
  where id = p_purchase_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) values (
    v_company_id, v_purchase.branch_id, v_user_id, 'purchase.update_date', 'purchase', p_purchase_id::text,
    jsonb_build_object('purchase_date', v_purchase.purchase_date),
    jsonb_build_object('purchase_date', p_purchase_date)
  );
end;
$$;

revoke all on function public.update_purchase_date(uuid, date) from public;
grant execute on function public.update_purchase_date(uuid, date) to authenticated;
