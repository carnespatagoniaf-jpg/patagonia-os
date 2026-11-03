-- 192: Sucursales etapa 4 (2026-11-02, plan Empresa, migración 189). Maqueta aprobada el 02/11.
--
-- 1) Precios por zona. Una zona es una lista de precios (167) marcada is_zone, siempre "precio general ± %"
--    (con precios a mano por producto en product_list_prices, como cualquier lista), asignada a uno o más locales
--    (branches.price_zone_id; un local está en una sola zona o en ninguna = precio general).
--    El cobro NO cambia en la base: Mostrador manda price_list_id = la zona del local en cada renglón (como ya
--    hace con Mayorista) y create_pos_sale cobra ese precio con pos_item_list_id / price_list_price. Las etiquetas de
--    la balanza con importe se cobran por lo que dicen (sin lista): a la balanza de cada local se le mandan los
--    precios de su zona. Las zonas no aparecen como lista para elegir (Mostrador, Clientes, Stock → Mayorista).
-- 2) Compra centralizada que se reparte: distribute_purchase arma un envío (190, estado "preparando") por cada
--    local, desde el local donde entró la compra. No mueve stock: el envío sigue su camino (despachar → recibir).
--    No se reparte más de lo que se compró (contando los repartos anteriores que no se cancelaron).
-- 3) Abrir un local copiando la configuración de otro: create_branch_copy (cuentas de caja nuevas en $0,
--    mínimos, zona de precios, formato de etiquetas de la balanza y los encargados que también quedan a cargo).
--    El stock arranca en cero; los cajeros y el punto de venta se cargan aparte.

-- 1) Zonas -----------------------------------------------------------------------------------------------------

alter table public.price_lists add column if not exists is_zone boolean not null default false;
alter table public.branches add column if not exists price_zone_id uuid references public.price_lists(id) on delete set null;
create index if not exists branches_price_zone_idx on public.branches (price_zone_id) where price_zone_id is not null;

-- p_branch_ids = los locales de la zona (los que estaban en otra zona se pasan a esta; los que salen quedan con
-- el precio general). Devuelve el id de la zona.
create or replace function public.save_price_zone(p_id uuid, p_name text, p_pct numeric, p_branch_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_id uuid;
  v_branch uuid;
begin
  perform public.require_plan('empresa');
  v_profile := public.price_list_caller();
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'Poné un nombre a la zona (ej. Zona Norte)'; end if;
  if length(trim(p_name)) > 60 then raise exception 'El nombre es muy largo'; end if;
  if lower(trim(p_name)) in ('general', 'minorista') then raise exception 'El precio general es el de Stock: no hace falta crear esa zona'; end if;
  if p_pct is null or p_pct <= -50 or p_pct >= 200 then raise exception 'El porcentaje no es válido (entre −50 y 200)'; end if;
  if exists (select 1 from public.price_lists where company_id = v_profile.company_id and lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'Ya hay una lista o zona con ese nombre';
  end if;

  if p_id is null then
    insert into public.price_lists (company_id, name, base, pct, active, is_zone, created_by)
    values (v_profile.company_id, trim(p_name), 'retail', round(p_pct, 2), true, true, v_profile.id)
    returning id into v_id;
  else
    update public.price_lists set name = trim(p_name), pct = round(p_pct, 2), active = true
    where id = p_id and company_id = v_profile.company_id and is_zone
    returning id into v_id;
    if v_id is null then raise exception 'Zona inválida'; end if;
  end if;

  update public.branches set price_zone_id = null
  where company_id = v_profile.company_id and price_zone_id = v_id and not (id = any(coalesce(p_branch_ids, '{}')));
  foreach v_branch in array coalesce(p_branch_ids, '{}') loop
    update public.branches set price_zone_id = v_id where id = v_branch and company_id = v_profile.company_id;
    if not found then raise exception 'Local inválido'; end if;
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_profile.id, 'price_zone.save', 'price_list', v_id::text,
    jsonb_build_object('name', trim(p_name), 'pct', p_pct, 'branch_ids', p_branch_ids));
  return v_id;
end;
$$;
revoke all on function public.save_price_zone(uuid, text, numeric, uuid[]) from public, anon;
grant execute on function public.save_price_zone(uuid, text, numeric, uuid[]) to authenticated;

-- Una zona no se elige como lista de un cliente (su precio es el de un local, no de un cliente).
create or replace function public.price_zone_not_for_customers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price_list_id is not null and exists (select 1 from public.price_lists where id = new.price_list_id and is_zone) then
    raise exception 'Una zona de precios no se asigna a un cliente: elegí una lista (ej. Mayorista)';
  end if;
  return new;
end;
$$;
revoke all on function public.price_zone_not_for_customers() from public, anon, authenticated;
drop trigger if exists customers_price_zone_guard on public.customers;
create trigger customers_price_zone_guard before insert or update of price_list_id on public.customers
  for each row execute function public.price_zone_not_for_customers();

-- 2) Compra repartida ------------------------------------------------------------------------------------------

alter table public.branch_transfers add column if not exists purchase_id uuid references public.purchases(id);
create index if not exists branch_transfers_purchase_idx on public.branch_transfers (purchase_id) where purchase_id is not null;

-- p_plan: [{branch_id, items: [{product_id, quantity}]}]. Devuelve cuántos envíos armó.
create or replace function public.distribute_purchase(p_purchase_id uuid, p_plan jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_purchase record;
  v_entry jsonb;
  v_branch uuid;
  v_items jsonb;
  v_id uuid;
  v_count integer := 0;
  v_over record;
  v_notes text;
begin
  select * into c from public.transfers_caller();
  if c.role not in ('owner', 'admin', 'manager') then raise exception 'Solo el dueño, un administrador o un encargado reparte una compra'; end if;
  select p.id, p.branch_id, p.status, p.invoice_number, s.name as supplier_name into v_purchase
  from public.purchases p left join public.suppliers s on s.id = p.supplier_id
  where p.id = p_purchase_id and p.company_id = c.company_id
  for update of p;
  if v_purchase.id is null then raise exception 'Compra inválida'; end if;
  if v_purchase.status = 'voided' then raise exception 'Esa compra está anulada'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' then raise exception 'Falta el reparto'; end if;

  -- Lo repartido (con lo de antes que no se canceló) no puede pasar lo comprado de cada producto.
  select x.product_id, p.name, x.total, coalesce(b.bought, 0) as bought, coalesce(prev.sent, 0) as prev into v_over
  from (
    select (i->>'product_id')::uuid as product_id, sum(nullif(i->>'quantity', '')::numeric) as total
    from jsonb_array_elements(p_plan) e, jsonb_array_elements(coalesce(e->'items', '[]')) i
    group by 1
  ) x
  join public.products p on p.id = x.product_id
  left join (select product_id, sum(quantity) as bought from public.purchase_items where purchase_id = p_purchase_id group by 1) b on b.product_id = x.product_id
  left join (
    select it.product_id, sum(coalesce(it.sent_qty, 0)) as sent
    from public.branch_transfers t join public.branch_transfer_items it on it.transfer_id = t.id
    where t.purchase_id = p_purchase_id and t.status <> 'cancelado' group by 1
  ) prev on prev.product_id = x.product_id
  where x.total + coalesce(prev.sent, 0) > coalesce(b.bought, 0) + 0.0005
  limit 1;
  if v_over.product_id is not null then
    raise exception 'De % compraste % y querés repartir % (ya repartido antes: %)', v_over.name, v_over.bought, v_over.total, v_over.prev;
  end if;

  v_notes := 'Reparto de la compra' || coalesce(' a ' || v_purchase.supplier_name, '') || coalesce(' (factura ' || v_purchase.invoice_number || ')', '');
  for v_entry in select * from jsonb_array_elements(p_plan) loop
    v_branch := nullif(v_entry->>'branch_id', '')::uuid;
    select coalesce(jsonb_agg(i), '[]'::jsonb) into v_items
    from jsonb_array_elements(coalesce(v_entry->'items', '[]')) i where coalesce(nullif(i->>'quantity', '')::numeric, 0) > 0;
    if jsonb_array_length(v_items) = 0 then continue; end if;
    v_id := public.branch_transfer_save(c.company_id, c.user_id, c.role, c.branch_id, null, v_purchase.branch_id, v_branch, v_items, null, null, left(v_notes, 300));
    update public.branch_transfers set purchase_id = p_purchase_id where id = v_id;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'Poné cuánto va a cada local'; end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_purchase.branch_id, c.user_id, 'purchase.distribute', 'purchase', p_purchase_id::text, jsonb_build_object('transfers', v_count));
  return v_count;
end;
$$;
revoke all on function public.distribute_purchase(uuid, jsonb) from public, anon;
grant execute on function public.distribute_purchase(uuid, jsonb) to authenticated;

-- 3) Local nuevo copiando otro -----------------------------------------------------------------------------------

-- p_copy: {accounts, mins, zone, scale, managers} (true/false). Devuelve {id, accounts, mins, managers}.
create or replace function public.create_branch_copy(p_name text, p_source_branch_id uuid, p_copy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_source record;
  v_id uuid := gen_random_uuid();
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_acc record;
  v_acc_name text;
  v_accounts integer := 0;
  v_mins integer := 0;
  v_managers integer := 0;
begin
  perform public.require_plan('empresa');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador abre locales'; end if;
  if v_name is null then raise exception 'Poné el nombre del local'; end if;
  if length(v_name) > 60 then raise exception 'El nombre es muy largo'; end if;
  if exists (select 1 from public.branches where company_id = v_company_id and lower(name) = lower(v_name)) then
    raise exception 'Ya hay un local con ese nombre';
  end if;
  select id, name, price_zone_id into v_source from public.branches
  where id = p_source_branch_id and company_id = v_company_id and not is_vehicle;
  if v_source.id is null then raise exception 'Local de origen inválido'; end if;

  insert into public.branches (id, company_id, name) values (v_id, v_company_id, v_name);

  if coalesce((p_copy->>'accounts')::boolean, false) then
    for v_acc in
      select name, payment_method from public.treasury_accounts
      where company_id = v_company_id and branch_id = p_source_branch_id and active
        and not coalesce(is_safe, false) and cheque_role is null
      order by created_at
    loop
      -- "Efectivo Chacabuco" → "Efectivo Godoy Cruz"; si la cuenta no lleva el nombre del local, se le agrega.
      v_acc_name := case when position(v_source.name in v_acc.name) > 0
        then replace(v_acc.name, v_source.name, v_name) else v_acc.name || ' ' || v_name end;
      insert into public.treasury_accounts (company_id, name, payment_method, initial_balance, branch_id)
      values (v_company_id, left(v_acc_name, 80), v_acc.payment_method, 0, v_id);
      v_accounts := v_accounts + 1;
    end loop;
  end if;

  if coalesce((p_copy->>'mins')::boolean, false) then
    insert into public.branch_min_stock (company_id, branch_id, product_id, min_stock, updated_by)
    select v_company_id, v_id, product_id, min_stock, v_user_id from public.branch_min_stock where branch_id = p_source_branch_id;
    get diagnostics v_mins = row_count;
  end if;

  if coalesce((p_copy->>'zone')::boolean, false) and v_source.price_zone_id is not null then
    update public.branches set price_zone_id = v_source.price_zone_id where id = v_id;
  end if;

  if coalesce((p_copy->>'scale')::boolean, false) then
    insert into public.branch_scale_configs (company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type, created_by)
    select company_id, v_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type, v_user_id
    from public.branch_scale_configs where branch_id = p_source_branch_id;
  end if;

  if coalesce((p_copy->>'managers')::boolean, false) then
    insert into public.profile_branches (company_id, profile_id, branch_id, created_by)
    select distinct v_company_id, p.id, v_id, v_user_id
    from public.profiles p
    where p.company_id = v_company_id and p.active and p.role = 'manager'
      and (p.branch_id = p_source_branch_id or exists (select 1 from public.profile_branches pb where pb.profile_id = p.id and pb.branch_id = p_source_branch_id))
    on conflict do nothing;
    get diagnostics v_managers = row_count;
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_id, v_user_id, 'branch.create_copy', 'branch', v_id::text,
    jsonb_build_object('name', v_name, 'source', p_source_branch_id, 'copy', p_copy, 'accounts', v_accounts, 'mins', v_mins, 'managers', v_managers));

  return jsonb_build_object('id', v_id, 'accounts', v_accounts, 'mins', v_mins, 'managers', v_managers);
end;
$$;
revoke all on function public.create_branch_copy(text, uuid, jsonb) from public, anon;
grant execute on function public.create_branch_copy(text, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('192_branch_chain_tools') on conflict do nothing;
