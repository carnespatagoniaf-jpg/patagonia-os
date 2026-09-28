-- Recetas (fichas tecnicas / escandallo): un producto terminado (milanesas,
-- hamburguesas, ...) se define por sus insumos, la merma de cada uno, cuanto
-- rinde el lote y los costos extra. De ahi sale el costo por kg/unidad y un
-- precio sugerido. Etapa 1: solo costeo, NO toca el stock.
--
-- Semantica de una linea: `quantity` es lo que queda NETO en el producto
-- terminado (en la unidad del insumo) y `waste_pct` la merma al limpiarlo. Lo
-- que hay que comprar es el bruto = neto / (1 - merma), y ese bruto se paga al
-- costo actual del insumo (products.cost). El calculo es el mismo (y con el
-- mismo redondeo) que recipeCost() en packages/domain: si se toca uno hay que
-- tocar el otro y sus pruebas.
--
-- Seguridad: las recetas muestran costos, asi que solo las leen dueño y
-- administrador (mismo criterio que el permiso recipes.manage del frontend),
-- y no hay politicas de escritura: solo se escribe por las funciones de abajo.
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  product_id uuid not null references public.products(id),
  yield_qty numeric(14,3) not null check (yield_qty > 0),
  extra_cost numeric(14,2) not null default 0 check (extra_cost >= 0),
  margin_pct numeric(8,2) check (margin_pct is null or (margin_pct >= 0 and margin_pct <= 10000)),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, product_id)
);

create table if not exists public.recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  ingredient_product_id uuid not null references public.products(id),
  quantity numeric(14,3) not null check (quantity > 0),
  waste_pct numeric(5,2) not null default 0 check (waste_pct >= 0 and waste_pct < 100),
  position int not null default 0,
  unique (recipe_id, ingredient_product_id)
);

create index if not exists recipe_items_recipe_idx on public.recipe_items (recipe_id);

alter table public.recipes enable row level security;
alter table public.recipe_items enable row level security;

revoke all on public.recipes from anon, authenticated;
revoke all on public.recipe_items from anon, authenticated;
grant select on public.recipes to authenticated;
grant select on public.recipe_items to authenticated;

drop policy if exists recipes_admin_read on public.recipes;
create policy recipes_admin_read on public.recipes for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin'))
  );

drop policy if exists recipe_items_admin_read on public.recipe_items;
create policy recipe_items_admin_read on public.recipe_items for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin'))
  );

-- Crea o reemplaza la receta de un producto. Recibe los insumos como
-- [{ingredient_product_id, quantity, waste_pct}]. Todo o nada.
create or replace function public.save_recipe(
  p_product_id uuid,
  p_yield_qty numeric,
  p_extra_cost numeric,
  p_margin_pct numeric,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_recipe_id uuid;
  v_item jsonb;
  v_ingredient uuid;
  v_qty numeric;
  v_waste numeric;
  v_position int := 0;
  v_seen uuid[] := '{}';
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

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para editar recetas';
  end if;

  if not exists (select 1 from public.products where id = p_product_id and company_id = v_company_id) then
    raise exception 'Producto inválido';
  end if;

  if p_yield_qty is null or p_yield_qty <= 0 or p_yield_qty > 1000000 then
    raise exception 'El rinde tiene que ser mayor que cero';
  end if;

  if p_extra_cost is null or p_extra_cost < 0 or p_extra_cost > 1000000000 then
    raise exception 'El costo extra no es válido';
  end if;

  if p_margin_pct is not null and (p_margin_pct < 0 or p_margin_pct > 10000) then
    raise exception 'El margen no es válido';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La receta necesita al menos un insumo';
  end if;

  if jsonb_array_length(p_items) > 60 then
    raise exception 'Demasiados insumos (máximo 60)';
  end if;

  insert into public.recipes (company_id, product_id, yield_qty, extra_cost, margin_pct, notes, created_by)
  values (v_company_id, p_product_id, p_yield_qty, p_extra_cost, p_margin_pct, nullif(btrim(p_notes), ''), v_user_id)
  on conflict (company_id, product_id) do update
    set yield_qty = excluded.yield_qty,
        extra_cost = excluded.extra_cost,
        margin_pct = excluded.margin_pct,
        notes = excluded.notes,
        updated_at = now()
  returning id into v_recipe_id;

  delete from public.recipe_items where recipe_id = v_recipe_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_ingredient := (v_item->>'ingredient_product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_waste := coalesce((v_item->>'waste_pct')::numeric, 0);

    if v_ingredient = p_product_id then
      raise exception 'Un producto no puede ser insumo de su propia receta';
    end if;

    if v_ingredient = any(v_seen) then
      raise exception 'Hay un insumo repetido en la receta';
    end if;
    v_seen := v_seen || v_ingredient;

    if not exists (select 1 from public.products where id = v_ingredient and company_id = v_company_id) then
      raise exception 'Insumo inválido';
    end if;

    if v_qty is null or v_qty <= 0 or v_qty > 1000000 then
      raise exception 'La cantidad de cada insumo tiene que ser mayor que cero';
    end if;

    if v_waste < 0 or v_waste >= 100 then
      raise exception 'La merma tiene que estar entre 0 y 99,99 por ciento';
    end if;

    v_position := v_position + 1;
    insert into public.recipe_items (recipe_id, company_id, ingredient_product_id, quantity, waste_pct, position)
    values (v_recipe_id, v_company_id, v_ingredient, v_qty, v_waste, v_position);
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'recipe.save', 'recipe', v_recipe_id::text,
          jsonb_build_object('product_id', p_product_id, 'yield_qty', p_yield_qty, 'extra_cost', p_extra_cost,
                             'margin_pct', p_margin_pct, 'items', p_items));

  return v_recipe_id;
end;
$$;

revoke all on function public.save_recipe(uuid, numeric, numeric, numeric, text, jsonb) from public;
grant execute on function public.save_recipe(uuid, numeric, numeric, numeric, text, jsonb) to authenticated;

-- Carga el costo que da la receta HOY (con el costo actual de cada insumo) en
-- el producto terminado y, si se manda p_price, tambien su precio de venta.
-- El costo se calcula aca, del lado del servidor, no se confia en el que vio la
-- pantalla.
create or replace function public.apply_recipe_to_product(p_recipe_id uuid, p_price numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_recipe public.recipes%rowtype;
  v_lines numeric;
  v_batch numeric;
  v_unit numeric;
  v_product record;
  v_new_price numeric;
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

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para aplicar recetas';
  end if;

  select * into v_recipe
  from public.recipes
  where id = p_recipe_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Receta inválida';
  end if;

  if p_price is not null and (p_price < 0 or p_price > 1000000000) then
    raise exception 'El precio no es válido';
  end if;

  select coalesce(sum(round((i.quantity / (1 - i.waste_pct / 100)) * p.cost, 2)), 0)
  into v_lines
  from public.recipe_items i
  join public.products p on p.id = i.ingredient_product_id and p.company_id = v_company_id
  where i.recipe_id = v_recipe.id;

  v_batch := round(v_lines + v_recipe.extra_cost, 2);
  v_unit := round(v_batch / v_recipe.yield_qty, 2);

  select id, cost, price_retail into v_product
  from public.products
  where id = v_recipe.product_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Producto inválido';
  end if;

  v_new_price := coalesce(p_price, v_product.price_retail);

  update public.products set cost = v_unit, price_retail = v_new_price where id = v_product.id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'recipe.apply', 'recipe', v_recipe.id::text,
          jsonb_build_object('product_id', v_product.id,
                             'cost_from', v_product.cost, 'cost_to', v_unit,
                             'price_from', v_product.price_retail, 'price_to', v_new_price,
                             'batch_cost', v_batch));

  return jsonb_build_object('cost', v_unit, 'price', v_new_price, 'batch_cost', v_batch);
end;
$$;

revoke all on function public.apply_recipe_to_product(uuid, numeric) from public;
grant execute on function public.apply_recipe_to_product(uuid, numeric) to authenticated;

create or replace function public.delete_recipe(p_recipe_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_recipe public.recipes%rowtype;
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

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para borrar recetas';
  end if;

  select * into v_recipe
  from public.recipes
  where id = p_recipe_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Receta inválida';
  end if;

  delete from public.recipes where id = v_recipe.id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'recipe.delete', 'recipe', v_recipe.id::text,
          jsonb_build_object('product_id', v_recipe.product_id));
end;
$$;

revoke all on function public.delete_recipe(uuid) from public;
grant execute on function public.delete_recipe(uuid) to authenticated;

notify pgrst, 'reload schema';
