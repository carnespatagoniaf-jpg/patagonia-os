-- Presentaciones que descuentan stock de otro producto ("stock compartido").
-- Pedido del dueño, 2026-10-08: un cliente mayorista/minorista tiene la misma
-- mercadería cargada como varios productos con distinto precio (PATA MUSLO,
-- oferta 3 kg, oferta 5 kg, mayorista, cajón x15...). Las compras suman en uno
-- y las ventas restan en otro, así que el stock nunca da bien.
--
-- 1) products.stock_source_id: si está cargado, el producto es una
--    "presentación" que vende con su propio código y precio pero usa el stock
--    del producto principal. products.stock_factor: cuánto del principal
--    descuenta cada unidad de la presentación (1 si se venden en la misma
--    unidad; 15 para un "cajón x15" de un principal en kg).
-- 2) Trigger BEFORE INSERT en inventory_movements: todo movimiento de una
--    presentación se reescribe al principal (cantidad x factor) y guarda la
--    presentación original en via_product_id. Así quedan cubiertas TODAS las
--    funciones que mueven stock (Mostrador, fiado, Compras, anulaciones,
--    despiece, transferencias...) sin reescribir ninguna. Un principal nunca
--    tiene principal (lo valida el trigger de products), así que el factor no
--    se aplica dos veces aunque una anulación copie un movimiento existente.
--    El ajuste manual ('adjustment') de una presentación se rechaza: se ajusta
--    el principal.
-- 3) products_with_stock: el stock de una presentación es el del principal
--    dividido por el factor. Se agregan stock_source_id y stock_factor al final.
-- 4) set_product_stock_source: vincula/desvincula. Al vincular, deja en cero el
--    stock propio que tenía la presentación (por sucursal) y, si se pide, lo
--    pasa al principal (x factor).
--
-- Todos los planes (es un arreglo de stock, no una pantalla nueva).

alter table public.products
  add column if not exists stock_source_id uuid references public.products(id) on delete set null,
  add column if not exists stock_factor numeric(14,3) not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_factor_positive') then
    alter table public.products add constraint products_stock_factor_positive check (stock_factor > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_stock_source_not_self') then
    alter table public.products add constraint products_stock_source_not_self check (stock_source_id is null or stock_source_id <> id);
  end if;
end $$;

create index if not exists products_stock_source_idx on public.products (stock_source_id) where stock_source_id is not null;

alter table public.inventory_movements
  add column if not exists via_product_id uuid references public.products(id) on delete set null;

-- Validación del vínculo (también cubre updates directos a la tabla).
create or replace function public.products_stock_source_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.products%rowtype;
begin
  if new.stock_source_id is null then
    new.stock_factor := 1;
    return new;
  end if;

  if new.stock_factor is null or new.stock_factor <= 0 then
    raise exception 'La cantidad que descuenta cada unidad tiene que ser mayor que cero';
  end if;

  select * into v_source from public.products where id = new.stock_source_id;
  if v_source.id is null or v_source.company_id <> new.company_id then
    raise exception 'Producto principal inválido';
  end if;
  if v_source.id = new.id then
    raise exception 'Un producto no puede descontar stock de sí mismo';
  end if;
  if v_source.stock_source_id is not null then
    raise exception '"%" ya descuenta stock de otro producto: elegí el producto principal', v_source.name;
  end if;
  if exists (select 1 from public.products where stock_source_id = new.id) then
    raise exception '"%" es el producto principal de otras presentaciones: no puede descontar stock de otro', new.name;
  end if;

  return new;
end;
$$;

drop trigger if exists products_stock_source_guard on public.products;
create trigger products_stock_source_guard
  before insert or update of stock_source_id, stock_factor, company_id on public.products
  for each row execute function public.products_stock_source_guard();

-- Redirige al principal todo movimiento de una presentación.
create or replace function public.inventory_movements_use_stock_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id uuid;
  v_factor numeric;
  v_name text;
  v_source_name text;
begin
  select stock_source_id, stock_factor, name into v_source_id, v_factor, v_name
  from public.products where id = new.product_id;

  if v_source_id is null then
    return new;
  end if;

  if new.movement_type = 'adjustment' then
    select name into v_source_name from public.products where id = v_source_id;
    raise exception '"%" usa el stock de "%". Ajustá el stock en "%".', v_name, v_source_name, v_source_name;
  end if;

  new.via_product_id := new.product_id;
  new.product_id := v_source_id;
  new.quantity := round(new.quantity * v_factor, 3);
  return new;
end;
$$;

drop trigger if exists inventory_movements_use_stock_source on public.inventory_movements;
create trigger inventory_movements_use_stock_source
  before insert on public.inventory_movements
  for each row execute function public.inventory_movements_use_stock_source();

revoke all on function public.products_stock_source_guard() from public, anon, authenticated;
revoke all on function public.inventory_movements_use_stock_source() from public, anon, authenticated;

-- Misma vista que antes (filtro por empresa adentro, costo oculto a cajeros);
-- solo cambia el stock de las presentaciones y se agregan dos columnas al final.
create or replace view public.products_with_stock as
select
  p.id,
  p.company_id,
  b.id as branch_id,
  p.code,
  p.name,
  p.unit,
  (case
     when (select profiles.role from public.profiles where profiles.id = auth.uid()) = 'cashier' then null::numeric
     else p.cost
   end)::numeric(14,2) as cost,
  p.price_retail,
  p.min_stock,
  p.active,
  case
    when p.stock_source_id is null then coalesce(cs.quantity, 0::numeric)
    else round(coalesce(css.quantity, 0::numeric) / p.stock_factor, 3)
  end as stock,
  p.category_id,
  p.stock_source_id,
  p.stock_factor
from public.products p
cross join public.branches b
left join public.current_stock cs
  on cs.company_id = p.company_id and cs.branch_id = b.id and cs.product_id = p.id
left join public.current_stock css
  on css.company_id = p.company_id and css.branch_id = b.id and css.product_id = p.stock_source_id
where b.company_id = p.company_id
  and b.active = true
  and p.company_id = public.current_company_id();

-- Vincular (p_source_id) o desvincular (null) una presentación.
create or replace function public.set_product_stock_source(
  p_product_id uuid,
  p_source_id uuid,
  p_factor numeric default 1,
  p_move_stock boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_product public.products%rowtype;
  v_source public.products%rowtype;
  v_factor numeric := coalesce(p_factor, 1);
  v_row record;
  v_moved numeric := 0;
  v_cleared numeric := 0;
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

  if v_role not in ('owner', 'admin', 'manager', 'production') then
    raise exception 'No autorizado para cambiar el stock de los productos';
  end if;

  select * into v_product from public.products
  where id = p_product_id and company_id = v_company_id
  for update;

  if v_product.id is null then
    raise exception 'Producto inválido';
  end if;

  if p_source_id is null then
    update public.products set stock_source_id = null, stock_factor = 1 where id = v_product.id;
  else
    select * into v_source from public.products
    where id = p_source_id and company_id = v_company_id
    for update;

    if v_source.id is null then
      raise exception 'Producto principal inválido';
    end if;

    if v_factor <= 0 or v_factor > 100000 then
      raise exception 'La cantidad que descuenta cada unidad tiene que ser mayor que cero';
    end if;

    -- Recién se vincula: el stock propio que tenía queda en cero (y, si se
    -- pide, se suma al principal). Se hace ANTES de vincular, para que el
    -- trigger de movimientos todavía no lo redirija.
    if v_product.stock_source_id is null then
      if exists (select 1 from public.products where stock_source_id = v_product.id) then
        raise exception '"%" es el producto principal de otras presentaciones: no puede descontar stock de otro', v_product.name;
      end if;
      if v_source.stock_source_id is not null then
        raise exception '"%" ya descuenta stock de otro producto: elegí el producto principal', v_source.name;
      end if;

      for v_row in
        select branch_id, sum(quantity) as qty
        from public.inventory_movements
        where company_id = v_company_id and product_id = v_product.id
        group by branch_id
        having sum(quantity) <> 0
      loop
        insert into public.inventory_movements (
          company_id, branch_id, product_id, movement_type, quantity, reference_type, reason, created_by
        ) values (
          v_company_id, v_row.branch_id, v_product.id, 'adjustment', -v_row.qty,
          'stock_source_link', 'Pasa a usar el stock de ' || v_source.name, v_user_id
        );
        v_cleared := v_cleared + v_row.qty;

        if p_move_stock then
          insert into public.inventory_movements (
            company_id, branch_id, product_id, movement_type, quantity, reference_type, reason, created_by, via_product_id
          ) values (
            v_company_id, v_row.branch_id, v_source.id, 'adjustment', round(v_row.qty * v_factor, 3),
            'stock_source_link', 'Stock que tenía ' || v_product.name, v_user_id, v_product.id
          );
          v_moved := v_moved + round(v_row.qty * v_factor, 3);
        end if;
      end loop;
    end if;

    update public.products
    set stock_source_id = v_source.id, stock_factor = v_factor
    where id = v_product.id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'product.stock_source', 'product', v_product.id::text,
          jsonb_build_object('previous_source_id', v_product.stock_source_id, 'source_id', p_source_id,
                             'factor', case when p_source_id is null then 1 else v_factor end,
                             'move_stock', p_move_stock, 'cleared', v_cleared, 'moved', v_moved));

  return jsonb_build_object('cleared', v_cleared, 'moved', v_moved);
end;
$$;

revoke all on function public.set_product_stock_source(uuid, uuid, numeric, boolean) from public, anon;
grant execute on function public.set_product_stock_source(uuid, uuid, numeric, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('111_shared_stock_products') on conflict do nothing;
