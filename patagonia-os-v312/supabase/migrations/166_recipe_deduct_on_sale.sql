-- Recetas que descuentan insumos al vender (pedido del dueño, 2026-10-28:
-- "cuando uno vende milanesas o chorizos que se vaya bajando el stock de lo
-- que lleva la receta", y que sea fácil, sin cargar "hoy hice tanto").
--
-- 1) recipes.deduct_on_sale (default false: nada cambia para las recetas que
--    ya existen). Se prende/apaga por receta con set_recipe_deduct_on_sale.
-- 2) Trigger AFTER INSERT en inventory_movements: cuando sale un producto
--    terminado con esa opción (Mostrador 'pos_sale' o entrega a cuenta
--    'customer_charge'), se escriben dos cosas con reference_type 'recipe' y
--    el mismo reference_id de la venta:
--      - cada insumo baja lo que lleva lo vendido, con su merma:
--        vendido x (neto / (1 - merma)) / rinde, igual que recipeCost();
--      - el producto terminado vuelve a subir lo vendido ("se elaboró en el
--        momento"), así su stock queda como estaba en vez de ir a negativo.
--    Igual que el trigger de presentaciones (111), cubre todas las funciones
--    que venden sin reescribir ninguna (create_pos_sale tiene inyecciones
--    distintas en cada base).
-- 3) Anulación ('pos_sale_void') o borrado de entrega ('customer_charge_void'):
--    se devuelven los movimientos de receta QUE SE HICIERON en esa venta (no se
--    recalcula con la receta de hoy). Si la venta tenía el producto en varios
--    renglones, cada renglón anulado devuelve su parte proporcional. Si la
--    venta se hizo con la opción apagada, no hay nada que devolver.
-- 4) Los reportes no cambian: Resultado del período costea por pos_sale_items
--    y por movimientos 'customer_charge', y estos son 'recipe'. Borrar una
--    entrega (086) revierte solo los 'customer_charge'; la parte de receta la
--    revierte este trigger.
--
-- Si algo falla adentro del trigger, la venta pasa igual (sin descontar insumos) y
-- queda un warning en el log de Postgres.
--
-- Un insumo que es presentación pasa por el trigger de 111 (va al principal).
-- No se "abren" sub-recetas: si un insumo es a su vez un producto con receta,
-- baja su stock propio. Plan Estándar, como Recetas.

alter table public.recipes
  add column if not exists deduct_on_sale boolean not null default false;

alter table public.inventory_movements
  add column if not exists recipe_product_id uuid references public.products(id) on delete set null;

-- La anulación busca los movimientos de la venta por reference_id (no había índice).
create index if not exists inventory_movements_reference_idx
  on public.inventory_movements (reference_id, reference_type)
  where reference_id is not null;

create or replace function public.inventory_movements_recipe_deduct()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe public.recipes%rowtype;
  v_item record;
  v_qty numeric;
  v_sold numeric;
  v_fraction numeric;
begin
  -- Nunca frena una venta ni una anulación (mismo criterio que 157): si algo falla, la venta pasa sin descontar insumos.
  begin
  if new.reference_id is null then
    return null;
  end if;

  if new.reference_type in ('pos_sale', 'customer_charge') and new.quantity < 0 then
    select * into v_recipe
    from public.recipes
    where company_id = new.company_id and product_id = new.product_id and deduct_on_sale;

    if v_recipe.id is null then
      return null;
    end if;

    for v_item in
      select ingredient_product_id, quantity, waste_pct
      from public.recipe_items
      where recipe_id = v_recipe.id
      order by position
    loop
      v_qty := round(new.quantity * (v_item.quantity / (1 - v_item.waste_pct / 100)) / v_recipe.yield_qty, 3);
      if v_qty <> 0 then
        insert into public.inventory_movements (
          company_id, branch_id, product_id, movement_type, quantity,
          reference_type, reference_id, reason, created_by, recipe_product_id
        ) values (
          new.company_id, new.branch_id, v_item.ingredient_product_id, 'recipe_use', v_qty,
          'recipe', new.reference_id, 'Insumo de receta vendida', new.created_by, new.product_id
        );
      end if;
    end loop;

    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by, recipe_product_id
    ) values (
      new.company_id, new.branch_id, new.product_id, 'recipe_output', -new.quantity,
      'recipe', new.reference_id, 'Elaborado al vender (receta)', new.created_by, new.product_id
    );
    return null;
  end if;

  if new.reference_type in ('pos_sale_void', 'customer_charge_void') and new.quantity > 0 then
    -- Lo que se vendió de este producto en esa venta (puede venir en varios renglones).
    select -sum(quantity) into v_sold
    from public.inventory_movements
    where reference_id = new.reference_id
      and reference_type = case new.reference_type when 'pos_sale_void' then 'pos_sale' else 'customer_charge' end
      and product_id = new.product_id
      and quantity < 0;

    if coalesce(v_sold, 0) <= 0 then
      return null;
    end if;
    v_fraction := least(new.quantity / v_sold, 1);

    for v_item in
      select product_id, movement_type, sum(quantity) as quantity
      from public.inventory_movements
      where reference_type = 'recipe'
        and reference_id = new.reference_id
        and recipe_product_id = new.product_id
        and movement_type in ('recipe_use', 'recipe_output')
      group by product_id, movement_type
    loop
      v_qty := round(-v_item.quantity * v_fraction, 3);
      if v_qty <> 0 then
        insert into public.inventory_movements (
          company_id, branch_id, product_id, movement_type, quantity,
          reference_type, reference_id, reason, created_by, recipe_product_id
        ) values (
          new.company_id, new.branch_id, v_item.product_id,
          case v_item.movement_type when 'recipe_use' then 'recipe_use_void' else 'recipe_output_void' end,
          v_qty, 'recipe', new.reference_id, 'Anulación de receta vendida', new.created_by, new.product_id
        );
      end if;
    end loop;
  end if;
  exception when others then
    raise warning 'Receta: no se descontaron los insumos (%)', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists inventory_movements_recipe_deduct on public.inventory_movements;
create trigger inventory_movements_recipe_deduct
  after insert on public.inventory_movements
  for each row
  when (new.reference_type in ('pos_sale', 'customer_charge', 'pos_sale_void', 'customer_charge_void'))
  execute function public.inventory_movements_recipe_deduct();

revoke all on function public.inventory_movements_recipe_deduct() from public, anon, authenticated;

create or replace function public.set_recipe_deduct_on_sale(p_recipe_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para editar recetas';
  end if;

  update public.recipes
  set deduct_on_sale = coalesce(p_enabled, false), updated_at = now()
  where id = p_recipe_id and company_id = v_company_id;

  if not found then
    raise exception 'Receta inválida';
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'recipe.deduct_on_sale', 'recipe', p_recipe_id::text,
          jsonb_build_object('enabled', coalesce(p_enabled, false)));
end;
$$;

revoke all on function public.set_recipe_deduct_on_sale(uuid, boolean) from public, anon;
grant execute on function public.set_recipe_deduct_on_sale(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('166_recipe_deduct_on_sale') on conflict do nothing;
