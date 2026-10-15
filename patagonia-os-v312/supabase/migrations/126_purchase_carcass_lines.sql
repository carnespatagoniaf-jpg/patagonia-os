-- 126: la factura se carga SOLO en Compras; lo que se desposta aparece solo en Despiece (2026-10-15, pedido del dueño:
-- "el pollero me entregó 4 cajones de pollo, un pan rallado y una caja de bondiolas: no puedo cargarlo en Despiece y
-- después en Proveedores").
--
-- 1. Cada línea de compra puede ir "para despostar": purchase_items.carcass_animal_type (Pollo, Vaca / media res…) y
--    carcass_weight (kilos totales; si la línea es por kg, son los mismos kilos). No suma stock por sí sola.
-- 2. create_purchase_transaction (misma firma) crea por cada línea así una res en Despiece
--    (carcass_batches.purchase_item_id) con fecha, proveedor, kilos y costo de la factura. La deuda con el proveedor
--    es la de la compra: la res NO crea otra compra.
-- 3. Si hay plantilla de cortes para ese animal (y suma ≤ 100 %), los cortes se cargan solos (from_template) y entran
--    a Stock; el costo real de cada corte lo pone la 123 (triggers). Mismo cálculo que carcassTemplateCutWeight y el
--    precio de referencia de cada corte = precio de venta del producto (igual que Despiece al crear una res).
-- 4. La compra manda:
--    - corregir cantidad/precio de la línea → la res toma los kilos/costo nuevos; si sus cortes son todos de la
--      plantilla se rehacen con los kilos nuevos; si alguien los cargó a mano y los kilos nuevos no alcanzan, se rechaza.
--      Si la línea es por unidad (cajones), los kilos se ajustan en proporción a la cantidad.
--    - corregir la fecha → la res toma la fecha.
--    - anular la compra → se borran la res y sus cortes (y el stock que sumaron), igual que el resto de la compra.
-- 5. Despiece no deja corregir peso/costo/fecha/proveedor ni borrar una res que viene de una compra: se hace en Compras.
--    Una res cargada directo en Despiece sigue funcionando igual que antes.

alter table public.purchase_items
  add column if not exists carcass_animal_type text,
  add column if not exists carcass_weight numeric(14,3);

alter table public.carcass_batches
  add column if not exists purchase_item_id uuid references public.purchase_items(id) on delete set null;

create unique index if not exists carcass_batches_purchase_item_uidx
  on public.carcass_batches (purchase_item_id) where purchase_item_id is not null;

alter table public.carcass_cuts
  add column if not exists from_template boolean not null default false;

-- Un corte que alguien corrige a mano deja de ser "de la plantilla".
create or replace function public.carcass_cuts_mark_manual()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('patagonia.carcass_auto', true), '') <> 'on'
     and (new.weight is distinct from old.weight or new.product_id is distinct from old.product_id
          or new.unit_price is distinct from old.unit_price or new.cut_name is distinct from old.cut_name) then
    new.from_template := false;
  end if;
  return new;
end;
$$;

drop trigger if exists carcass_cuts_mark_manual on public.carcass_cuts;
create trigger carcass_cuts_mark_manual
  before update on public.carcass_cuts
  for each row execute function public.carcass_cuts_mark_manual();

-- Interno: borra los cortes de una res (y el stock que sumaron). Solo los de la plantilla si p_only_template.
create or replace function public.carcass_delete_cuts_core(p_batch_id uuid, p_only_template boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from public.carcass_cuts
  where batch_id = p_batch_id and (not p_only_template or from_template);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  perform set_config('patagonia.carcass_auto', 'on', true);
  update public.carcass_cuts set inventory_movement_id = null where id = any(v_ids) and inventory_movement_id is not null;
  perform set_config('patagonia.carcass_auto', 'off', true);
  delete from public.inventory_movements where reference_type = 'carcass_cut' and reference_id = any(v_ids);
  delete from public.carcass_cuts where id = any(v_ids);
  return cardinality(v_ids);
end;
$$;

-- Interno: carga los cortes de la plantilla en una res sin cortes. Devuelve cuántos cargó (0 = sin plantilla).
create or replace function public.carcass_fill_from_template(p_batch_id uuid, p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.carcass_batches%rowtype;
  v_sum numeric;
  t record;
  v_weight numeric;
  v_cut_id uuid;
  v_movement_id uuid;
  v_count int := 0;
begin
  select * into v_batch from public.carcass_batches where id = p_batch_id;
  if v_batch.id is null or v_batch.total_weight <= 0 then
    return 0;
  end if;
  if exists (select 1 from public.carcass_cuts where batch_id = p_batch_id) then
    return 0;
  end if;

  select coalesce(sum(yield_percent), 0) into v_sum
  from public.carcass_cut_templates
  where company_id = v_batch.company_id and lower(trim(animal_type)) = lower(trim(v_batch.animal_type));
  if v_sum <= 0 or v_sum > 100 then
    return 0;
  end if;

  for t in
    select ct.cut_name, ct.yield_percent, ct.product_id, p.price_retail
    from public.carcass_cut_templates ct
    left join public.products p on p.id = ct.product_id and p.company_id = v_batch.company_id
    where ct.company_id = v_batch.company_id and lower(trim(ct.animal_type)) = lower(trim(v_batch.animal_type))
    order by ct.sort_order, ct.created_at
  loop
    v_weight := round(v_batch.total_weight * (t.yield_percent / 100), 3);
    continue when v_weight <= 0;
    v_cut_id := gen_random_uuid();
    v_movement_id := null;
    if t.product_id is not null and t.price_retail is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by
      ) values (
        v_batch.company_id, v_batch.branch_id, t.product_id, 'despiece', v_weight,
        'carcass_cut', v_cut_id, 'Despiece · ' || trim(t.cut_name), p_user_id
      )
      returning id into v_movement_id;
    end if;
    insert into public.carcass_cuts (id, batch_id, cut_name, product_id, weight, unit_price, line_total, inventory_movement_id, from_template)
    values (v_cut_id, p_batch_id, trim(t.cut_name), case when t.price_retail is not null then t.product_id end, v_weight,
            coalesce(t.price_retail, 0), round(v_weight * coalesce(t.price_retail, 0), 2), v_movement_id, true);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Interno: crea la res de Despiece de una línea de compra "para despostar".
create or replace function public.carcass_batch_from_purchase_item(p_item_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_batch_id uuid := gen_random_uuid();
  v_cuts int;
begin
  select pi.id, pi.carcass_animal_type, pi.carcass_weight, pi.line_total,
         p.id as purchase_id, p.company_id, p.branch_id, p.supplier_id, p.purchase_date, p.invoice_number
  into v_item
  from public.purchase_items pi join public.purchases p on p.id = pi.purchase_id
  where pi.id = p_item_id;
  if v_item.id is null or v_item.carcass_animal_type is null then
    return null;
  end if;

  insert into public.carcass_batches (
    id, company_id, branch_id, batch_date, animal_type, supplier_id, total_weight, total_cost, notes,
    purchase_id, purchase_item_id, created_by
  ) values (
    v_batch_id, v_item.company_id, v_item.branch_id, v_item.purchase_date, v_item.carcass_animal_type, v_item.supplier_id,
    v_item.carcass_weight, v_item.line_total,
    'De la compra' || coalesce(' · Fact. ' || nullif(trim(v_item.invoice_number), ''), ''),
    v_item.purchase_id, v_item.id, p_user_id
  );

  v_cuts := public.carcass_fill_from_template(v_batch_id, p_user_id);
  return jsonb_build_object('batch_id', v_batch_id, 'animal_type', v_item.carcass_animal_type, 'cuts', v_cuts);
end;
$$;

-- La compra manda: línea corregida → la res se ajusta.
create or replace function public.purchase_items_carcass_before()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.carcass_animal_type is not null then
    if new.unit = 'kg' then
      new.carcass_weight := new.quantity;
    elsif old.quantity > 0 and new.quantity is distinct from old.quantity then
      new.carcass_weight := round(old.carcass_weight * new.quantity / old.quantity, 3);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_items_carcass_before on public.purchase_items;
create trigger purchase_items_carcass_before
  before update on public.purchase_items
  for each row execute function public.purchase_items_carcass_before();

create or replace function public.purchase_items_carcass_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.carcass_batches%rowtype;
  v_cuts_weight numeric;
  v_manual int;
begin
  if new.carcass_animal_type is null then
    return null;
  end if;
  select * into v_batch from public.carcass_batches where purchase_item_id = new.id;
  if v_batch.id is null then
    return null;
  end if;

  if new.carcass_weight is distinct from v_batch.total_weight then
    select count(*) filter (where not from_template), coalesce(sum(weight), 0)
    into v_manual, v_cuts_weight
    from public.carcass_cuts where batch_id = v_batch.id;

    if v_manual = 0 then
      perform public.carcass_delete_cuts_core(v_batch.id, true);
      update public.carcass_batches set total_weight = new.carcass_weight, total_cost = new.line_total where id = v_batch.id;
      perform public.carcass_fill_from_template(v_batch.id, auth.uid());
    else
      if v_cuts_weight > new.carcass_weight then
        raise exception 'Los cortes cargados en Despiece suman % kg, más que los % kg corregidos. Corregí primero los cortes en Despiece.',
          round(v_cuts_weight, 3), new.carcass_weight;
      end if;
      update public.carcass_batches set total_weight = new.carcass_weight, total_cost = new.line_total where id = v_batch.id;
    end if;
  elsif new.line_total is distinct from v_batch.total_cost then
    update public.carcass_batches set total_cost = new.line_total where id = v_batch.id;
  end if;
  return null;
end;
$$;

drop trigger if exists purchase_items_carcass_sync on public.purchase_items;
create trigger purchase_items_carcass_sync
  after update on public.purchase_items
  for each row execute function public.purchase_items_carcass_sync();

-- La compra manda: fecha corregida o compra anulada.
create or replace function public.purchases_carcass_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
begin
  for b in
    select cb.id from public.carcass_batches cb
    join public.purchase_items pi on pi.id = cb.purchase_item_id
    where pi.purchase_id = new.id
  loop
    if new.status <> 'active' and old.status = 'active' then
      perform public.carcass_delete_cuts_core(b.id, false);
      delete from public.carcass_batches where id = b.id;
    elsif new.purchase_date is distinct from old.purchase_date then
      update public.carcass_batches set batch_date = new.purchase_date where id = b.id;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists purchases_carcass_sync on public.purchases;
create trigger purchases_carcass_sync
  after update on public.purchases
  for each row execute function public.purchases_carcass_sync();

revoke all on function public.carcass_cuts_mark_manual() from public, anon, authenticated;
revoke all on function public.carcass_delete_cuts_core(uuid, boolean) from public, anon, authenticated;
revoke all on function public.carcass_fill_from_template(uuid, uuid) from public, anon, authenticated;
revoke all on function public.carcass_batch_from_purchase_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.purchase_items_carcass_before() from public, anon, authenticated;
revoke all on function public.purchase_items_carcass_sync() from public, anon, authenticated;
revoke all on function public.purchases_carcass_sync() from public, anon, authenticated;

-- Compras: misma firma; las líneas pueden traer carcass_animal_type / carcass_weight.
create or replace function public.create_purchase_transaction(p_branch_id uuid, p_supplier_id uuid, p_purchase_date date, p_invoice_number text, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_purchase_id uuid := gen_random_uuid();
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_product_id uuid;
  v_description text;
  v_quantity numeric(14,3);
  v_unit text;
  v_unit_price numeric(14,2);
  v_line_total numeric(14,2);
  v_item_id uuid;
  v_carcass_type text;
  v_carcass_weight numeric(14,3);
  v_carcass_ids uuid[] := '{}';
  v_carcass jsonb := '[]'::jsonb;
  v_id uuid;
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

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.suppliers
    where id = p_supplier_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_purchase_date is null then
    raise exception 'La fecha de compra es obligatoria';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'La compra no tiene ítems';
  end if;

  insert into public.purchases (
    id, company_id, branch_id, supplier_id, purchase_date, invoice_number, total, created_by
  ) values (
    v_purchase_id, v_company_id, p_branch_id, p_supplier_id, p_purchase_date, p_invoice_number, 0, v_user_id
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_description := nullif(v_item->>'description', '');
    v_quantity := (v_item->>'quantity')::numeric;
    v_unit := v_item->>'unit';
    v_unit_price := (v_item->>'unit_price')::numeric;
    -- 126: línea para despostar.
    v_carcass_type := nullif(trim(coalesce(v_item->>'carcass_animal_type', '')), '');
    v_carcass_weight := nullif(v_item->>'carcass_weight', '')::numeric;

    if v_carcass_type is not null then
      perform public.require_plan('estandar');
      if v_product_id is not null then
        raise exception 'Una línea para despostar no lleva producto: sus cortes entran a Stock por Despiece';
      end if;
      v_description := coalesce(v_description, v_carcass_type);
    end if;

    if v_product_id is null and v_description is null then
      raise exception 'Cada ítem necesita un producto o una descripción';
    end if;

    if v_quantity <= 0 or v_unit_price < 0 then
      raise exception 'Cantidad o precio inválido';
    end if;

    if v_unit not in ('kg','unit') then
      raise exception 'Unidad inválida';
    end if;

    if v_carcass_type is not null then
      if v_unit = 'kg' then
        v_carcass_weight := v_quantity;
      elsif v_carcass_weight is null or v_carcass_weight <= 0 then
        raise exception 'Para despostar "%" hacen falta los kilos totales', v_carcass_type;
      end if;
    else
      v_carcass_weight := null;
    end if;

    if v_product_id is not null and not exists (
      select 1 from public.products where id = v_product_id and company_id = v_company_id
    ) then
      raise exception 'Producto inválido';
    end if;

    v_line_total := v_quantity * v_unit_price;
    v_total := v_total + v_line_total;

    insert into public.purchase_items (
      purchase_id, product_id, description, quantity, unit, unit_price, line_total, carcass_animal_type, carcass_weight
    ) values (
      v_purchase_id, v_product_id, v_description, v_quantity, v_unit, v_unit_price, v_line_total,
      left(v_carcass_type, 80), v_carcass_weight
    )
    returning id into v_item_id;

    if v_carcass_type is not null then
      v_carcass_ids := v_carcass_ids || v_item_id;
    end if;

    if v_product_id is not null then
      insert into public.inventory_movements (
        company_id, branch_id, product_id, movement_type, quantity,
        reference_type, reference_id, reason, created_by
      ) values (
        v_company_id, p_branch_id, v_product_id, 'purchase', v_quantity,
        'purchase', v_purchase_id, 'Compra a proveedor', v_user_id
      );
    end if;
  end loop;

  update public.purchases set total = v_total where id = v_purchase_id;

  foreach v_id in array v_carcass_ids loop
    v_carcass := v_carcass || public.carcass_batch_from_purchase_item(v_id, v_user_id);
  end loop;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'purchase.create', 'purchase', v_purchase_id::text,
    jsonb_build_object('total', v_total, 'supplier_id', p_supplier_id, 'carcass', v_carcass)
  );

  return jsonb_build_object('id', v_purchase_id, 'total', v_total, 'carcass', v_carcass);
end;
$function$;

revoke all on function public.create_purchase_transaction(uuid, uuid, date, text, jsonb) from public, anon;
grant execute on function public.create_purchase_transaction(uuid, uuid, date, text, jsonb) to authenticated;

-- Despiece: una res que viene de una compra se corrige/borra en Compras. Se inyecta en la definición VIVA.
do $mig$
declare
  v_def text;
  v_anchor constant text := 'perform public.require_plan(''estandar'');';
  v_guard_save constant text := 'perform public.require_plan(''estandar'');
  -- 126: la res de una compra se corrige en Compras.
  if p_batch_id is not null and exists (select 1 from public.carcass_batches where id = p_batch_id and purchase_item_id is not null) then
    raise exception ''Esta res viene de una compra: el peso, el costo, la fecha y el proveedor se corrigen en Compras'';
  end if;';
  v_guard_delete constant text := 'perform public.require_plan(''estandar'');
  -- 126: la res de una compra se borra anulando la compra.
  if exists (select 1 from public.carcass_batches where id = p_batch_id and purchase_item_id is not null) then
    raise exception ''Esta res viene de una compra: para borrarla, anulá la compra en Compras'';
  end if;';
begin
  select pg_get_functiondef('public.save_carcass_batch(uuid, uuid, date, text, uuid, numeric, numeric, text)'::regprocedure) into v_def;
  if position('-- 126:' in v_def) = 0 then
    if position(v_anchor in v_def) = 0 then
      raise exception '126: save_carcass_batch no tiene require_plan, revisar a mano';
    end if;
    execute replace(v_def, v_anchor, v_guard_save);
  end if;

  select pg_get_functiondef('public.delete_carcass_batch(uuid)'::regprocedure) into v_def;
  if position('-- 126:' in v_def) = 0 then
    if position(v_anchor in v_def) = 0 then
      raise exception '126: delete_carcass_batch no tiene require_plan, revisar a mano';
    end if;
    execute replace(v_def, v_anchor, v_guard_delete);
  end if;
end;
$mig$;

insert into public.schema_migrations (version) values ('126_purchase_carcass_lines') on conflict do nothing;
