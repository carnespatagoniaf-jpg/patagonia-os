-- 204: Ingreso de stock por escaneo (pedido de Carplat / Axel, 18/11/2026).
--
-- "Como en el otro programa": una sola pantalla "Ingreso de stock" donde se escanea cada caja que llega (matambre,
-- paleta, roast beef…). Cada escaneo es una caja: el sistema sabe qué producto es y cuántos kilos trae, y al final
-- "Ingresar stock" entra todo junto. Antes había que ir producto por producto ("Entraron" para las cajas y Editar o
-- Ajustar para los kilos).
--
-- register_stock_entry(branch, items, note): un renglón por caja/paquete o por producto escrito a mano.
--   * Kilos (o unidades): un inventory_movements 'ingreso' por renglón, reference_type 'stock_entry'. Una presentación
--     se pasa a su principal sola (trigger de la 111), como cualquier movimiento.
--   * Cajas: con la pantalla 'paquetes', cada renglón marcado como caja (box) suma 1 en product_package_moves
--     ('envasado', reference_id = el ingreso) y el producto empieza a contar cajas.
--   * Queda guardado en stock_entries / stock_entry_items (con el código de cada etiqueta), para ver los últimos
--     ingresos y avisar si una caja ya había entrado.
-- undo_stock_entry(id): deshace un ingreso entero (movimientos y cajas en contra). Dueño o administrador.
-- No toca compras, costos, proveedores ni Tesorería.

create table if not exists public.stock_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  note text,
  lines integer not null,
  total_kg numeric not null default 0,
  boxes integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid
);
create index if not exists stock_entries_company on public.stock_entries (company_id, branch_id, created_at desc);

create table if not exists public.stock_entry_items (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.stock_entries(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  product_id uuid not null references public.products(id),
  quantity numeric not null check (quantity > 0),
  code text,
  box boolean not null default false
);
create index if not exists stock_entry_items_entry on public.stock_entry_items (entry_id);
create index if not exists stock_entry_items_code on public.stock_entry_items (company_id, code) where code is not null;

alter table public.stock_entries enable row level security;
alter table public.stock_entry_items enable row level security;
drop policy if exists stock_entries_company_read on public.stock_entries;
create policy stock_entries_company_read on public.stock_entries
  for select to authenticated using (company_id = public.current_company_id());
drop policy if exists stock_entry_items_company_read on public.stock_entry_items;
create policy stock_entry_items_company_read on public.stock_entry_items
  for select to authenticated using (company_id = public.current_company_id());
-- Sin políticas de escritura: solo las funciones de abajo.

drop trigger if exists zz_accountant_readonly on public.stock_entries;
create trigger zz_accountant_readonly before insert or update or delete on public.stock_entries
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.stock_entry_items;
create trigger zz_accountant_readonly before insert or update or delete on public.stock_entry_items
  for each statement execute function public.accountant_readonly_guard();

-- p_items: [{product_id, quantity, code?, box?}]
create or replace function public.register_stock_entry(p_branch_id uuid, p_items jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_entry_id uuid := gen_random_uuid();
  v_packages boolean;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_code text;
  v_box boolean;
  v_lines integer := 0;
  v_kg numeric := 0;
  v_boxes integer := 0;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 120), '');
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production']);
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_profile.company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if v_profile.role not in ('owner', 'admin') and not public.my_branch_allowed(p_branch_id) then
    raise exception 'Solo podés ingresar stock en tu local';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada para ingresar';
  end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'Máximo 500 renglones por ingreso'; end if;

  select 'paquetes' = any(features) into v_packages from public.companies where id = v_profile.company_id;

  insert into public.stock_entries (id, company_id, branch_id, note, lines, created_by)
  values (v_entry_id, v_profile.company_id, p_branch_id, v_note, 0, v_user_id);

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
    where id = (v_item->>'product_id')::uuid and company_id = v_profile.company_id
    for update;
    if v_product.id is null then raise exception 'Producto inválido'; end if;
    v_qty := round((v_item->>'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 or v_qty > 2000 then
      raise exception 'Cantidad inválida para %', v_product.name;
    end if;
    if v_product.unit <> 'kg' and v_qty <> round(v_qty) then
      raise exception '% se cuenta por unidad: la cantidad tiene que ser entera', v_product.name;
    end if;
    v_code := nullif(left(btrim(coalesce(v_item->>'code', '')), 40), '');
    v_box := coalesce((v_item->>'box')::boolean, false);

    insert into public.stock_entry_items (entry_id, company_id, product_id, quantity, code, box)
    values (v_entry_id, v_profile.company_id, v_product.id, v_qty, v_code, v_box);

    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    values (v_profile.company_id, p_branch_id, v_product.id, 'ingreso', v_qty, 'stock_entry', v_entry_id,
            'Ingreso de stock' || coalesce(' · ' || v_note, ''), v_user_id);

    if v_box and coalesce(v_packages, false) then
      update public.products set track_packages = true where id = v_product.id and not track_packages;
      insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, reference_id, created_by)
      values (v_profile.company_id, p_branch_id, v_product.id, 1, 'envasado', v_entry_id, v_user_id);
    end if;

    v_lines := v_lines + 1;
    if v_product.unit = 'kg' then v_kg := v_kg + v_qty; end if;
    if v_box then v_boxes := v_boxes + 1; end if;
  end loop;

  update public.stock_entries set lines = v_lines, total_kg = v_kg, boxes = v_boxes where id = v_entry_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, p_branch_id, v_user_id, 'stock.entry', 'stock_entry', v_entry_id::text,
          jsonb_build_object('lines', v_lines, 'kg', v_kg, 'boxes', v_boxes, 'note', v_note));

  return jsonb_build_object('id', v_entry_id, 'lines', v_lines, 'kg', v_kg, 'boxes', v_boxes);
end;
$$;

-- Deshacer un ingreso entero (se cargó en el local equivocado, se escaneó de más…). Deja todo como antes.
create or replace function public.undo_stock_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_entry public.stock_entries%rowtype;
begin
  perform public.require_role(array['owner', 'admin']);
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  select * into v_entry from public.stock_entries
  where id = p_entry_id and company_id = v_profile.company_id for update;
  if v_entry.id is null then raise exception 'Ingreso inválido'; end if;
  if v_entry.undone_at is not null then raise exception 'Ese ingreso ya se deshizo'; end if;

  -- Un movimiento en contra por renglón, con el producto y la cantidad que se escanearon (una presentación la vuelve
  -- a pasar a su principal el trigger de la 111, igual que al ingresar).
  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  select i.company_id, v_entry.branch_id, i.product_id, 'ingreso_anulado', -i.quantity,
         'stock_entry', v_entry.id, 'Ingreso de stock deshecho', v_user_id
  from public.stock_entry_items i where i.entry_id = v_entry.id;

  insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, reference_id, created_by)
  select company_id, branch_id, product_id, -sum(delta)::integer, 'anulacion', v_entry.id, v_user_id
  from public.product_package_moves
  where reference_id = v_entry.id and kind = 'envasado'
  group by company_id, branch_id, product_id;

  update public.stock_entries set undone_at = now(), undone_by = v_user_id where id = v_entry.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data)
  values (v_profile.company_id, v_entry.branch_id, v_user_id, 'stock.entry_undo', 'stock_entry', v_entry.id::text,
          jsonb_build_object('lines', v_entry.lines, 'kg', v_entry.total_kg, 'boxes', v_entry.boxes));
end;
$$;

revoke all on function public.register_stock_entry(uuid, jsonb, text) from public, anon;
grant execute on function public.register_stock_entry(uuid, jsonb, text) to authenticated;
revoke all on function public.undo_stock_entry(uuid) from public, anon;
grant execute on function public.undo_stock_entry(uuid) to authenticated;

insert into public.schema_migrations (version) values ('204_stock_entry_scan') on conflict do nothing;
