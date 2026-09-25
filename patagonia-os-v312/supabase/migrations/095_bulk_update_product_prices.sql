-- Actualizacion masiva de precios/costos (inflacion). Recibe la lista exacta de
-- cambios que el usuario vio en la vista previa: [{product_id, price_retail?, cost?}].
-- Solo dueño, administrador o encargado. Cada producto se valida contra la
-- empresa del que llama, y queda UN registro de auditoria con antes/despues.
create or replace function public.bulk_update_product_prices(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_item jsonb;
  v_product record;
  v_price numeric;
  v_cost numeric;
  v_changes jsonb := '[]'::jsonb;
  v_count int := 0;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'No autorizado para actualizar precios';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay cambios para aplicar';
  end if;

  if jsonb_array_length(p_items) > 3000 then
    raise exception 'Demasiados productos de una vez (máximo 3000)';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select id, price_retail, cost into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid and company_id = v_company_id
    for update;

    if not found then
      raise exception 'Producto inválido';
    end if;

    v_price := coalesce((v_item->>'price_retail')::numeric, v_product.price_retail);
    v_cost := coalesce((v_item->>'cost')::numeric, v_product.cost);

    if v_price < 0 or v_cost < 0 or v_price > 1000000000 or v_cost > 1000000000 then
      raise exception 'Precio o costo fuera de rango';
    end if;

    if v_price <> v_product.price_retail or v_cost <> v_product.cost then
      update public.products set price_retail = v_price, cost = v_cost where id = v_product.id;
      v_count := v_count + 1;
      v_changes := v_changes || jsonb_build_object(
        'id', v_product.id,
        'price_from', v_product.price_retail, 'price_to', v_price,
        'cost_from', v_product.cost, 'cost_to', v_cost
      );
    end if;
  end loop;

  if v_count > 0 then
    insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_user_id, 'product.bulk_price_update', 'product', 'bulk',
            jsonb_build_object('count', v_count, 'changes', v_changes));
  end if;

  return jsonb_build_object('updated', v_count);
end;
$$;

revoke all on function public.bulk_update_product_prices(jsonb) from public;
grant execute on function public.bulk_update_product_prices(jsonb) to authenticated;

notify pgrst, 'reload schema';
