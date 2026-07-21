-- Despiece nunca sumaba nada a Stock: registrar que una res dio 10kg de
-- Chinchulín solo servía para calcular costos/ganancia del lote, sin que
-- ese peso apareciera como stock disponible de "Chinchulín". Ahora, si el
-- corte está vinculado a un producto real del catálogo (p_product_id), se
-- genera un ingreso de stock automático (inventory_movements) por ese peso.
-- Si no se elige producto (corte sin seguimiento de stock, ej. hueso/grasa
-- que no se venden como tal), sigue funcionando igual que hasta ahora, sin
-- tocar stock — mismo criterio que "cuenta opcional" en Deudas.
alter table public.carcass_cuts
  add column if not exists inventory_movement_id uuid references public.inventory_movements(id);

create or replace function public.save_carcass_cut(
  p_cut_id uuid,
  p_batch_id uuid,
  p_cut_name text,
  p_product_id uuid,
  p_weight numeric,
  p_unit_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_branch_id uuid;
  v_id uuid;
  v_line_total numeric(14,2);
  v_old_movement_id uuid;
  v_new_movement_id uuid;
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

  if p_cut_name is null or length(trim(p_cut_name)) = 0 then
    raise exception 'El nombre del corte es obligatorio';
  end if;

  if p_weight is null or p_weight <= 0 then
    raise exception 'El peso debe ser mayor que cero';
  end if;

  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'El precio no puede ser negativo';
  end if;

  select branch_id into v_branch_id
  from public.carcass_batches
  where id = p_batch_id and company_id = v_company_id;

  if v_branch_id is null then
    raise exception 'Res inválida';
  end if;

  if p_product_id is not null and not exists (
    select 1 from public.products where id = p_product_id and company_id = v_company_id
  ) then
    raise exception 'Producto inválido';
  end if;

  v_line_total := round(p_weight * p_unit_price, 2);

  if p_cut_id is not null then
    select inventory_movement_id into v_old_movement_id
    from public.carcass_cuts
    where id = p_cut_id and batch_id = p_batch_id;

    -- Se borra y recrea el movimiento (en vez de actualizarlo in-place)
    -- porque el producto puede cambiar de un corte a otro, y en el resto
    -- del sistema los movimientos de inventario no cambian de producto.
    if v_old_movement_id is not null then
      delete from public.inventory_movements where id = v_old_movement_id;
    end if;

    v_new_movement_id := null;
    if p_product_id is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, v_branch_id, p_product_id, 'despiece', p_weight,
        'carcass_cut', p_cut_id, 'Despiece · ' || trim(p_cut_name), v_user_id
      )
      returning id into v_new_movement_id;
    end if;

    update public.carcass_cuts
    set cut_name = trim(p_cut_name), product_id = p_product_id, weight = p_weight,
        unit_price = p_unit_price, line_total = v_line_total, inventory_movement_id = v_new_movement_id
    where id = p_cut_id and batch_id = p_batch_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Corte inválido';
    end if;
  else
    v_id := gen_random_uuid();

    if p_product_id is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, v_branch_id, p_product_id, 'despiece', p_weight,
        'carcass_cut', v_id, 'Despiece · ' || trim(p_cut_name), v_user_id
      )
      returning id into v_new_movement_id;
    end if;

    insert into public.carcass_cuts (id, batch_id, cut_name, product_id, weight, unit_price, line_total, inventory_movement_id)
    values (v_id, p_batch_id, trim(p_cut_name), p_product_id, p_weight, p_unit_price, v_line_total, v_new_movement_id);
  end if;

  return jsonb_build_object('id', v_id, 'line_total', v_line_total);
end;
$$;

revoke all on function public.save_carcass_cut(uuid,uuid,text,uuid,numeric,numeric) from public;
grant execute on function public.save_carcass_cut(uuid,uuid,text,uuid,numeric,numeric) to authenticated;

create or replace function public.delete_carcass_cut(
  p_cut_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
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

  select cc.inventory_movement_id into v_movement_id
  from public.carcass_cuts cc
  join public.carcass_batches b on b.id = cc.batch_id
  where cc.id = p_cut_id and b.company_id = v_company_id;

  delete from public.carcass_cuts cc
  using public.carcass_batches b
  where cc.id = p_cut_id and cc.batch_id = b.id and b.company_id = v_company_id;

  if v_movement_id is not null then
    delete from public.inventory_movements where id = v_movement_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_cut(uuid) from public;
grant execute on function public.delete_carcass_cut(uuid) to authenticated;

create or replace function public.delete_carcass_batch(
  p_batch_id uuid
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

  -- Los cortes se borran en cascada (on delete cascade), pero sus
  -- movimientos de stock vinculados no — hay que borrarlos a mano para no
  -- dejar el stock inflado con un despiece que ya no existe.
  delete from public.inventory_movements im
  using public.carcass_cuts cc
  where cc.batch_id = p_batch_id and im.id = cc.inventory_movement_id;

  delete from public.carcass_batches where id = p_batch_id and company_id = v_company_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_batch(uuid) from public;
grant execute on function public.delete_carcass_batch(uuid) to authenticated;
