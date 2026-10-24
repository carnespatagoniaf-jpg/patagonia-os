-- 157: Paquetes por producto (a pedido de M2 Alimentos, 24/10/2026).
--
-- Venden cortes envasados al vacío: el stock está en kilos (100 kg), pero quieren saber cuántos paquetes
-- tienen (20 paquetitos). Cada paquete pesa distinto, así que se cuentan uno por uno:
--   * "Envasé N" suma N paquetes; "Contar" deja el número que contaron (como el ajuste de stock).
--   * Cada etiqueta de balanza vendida en Mostrador resta 1 paquete (pos_sale_items.scale_tickets); una línea
--     escrita a mano de un producto por kilo resta 1; un producto por unidad resta su cantidad.
--   * Anular la venta los devuelve.
-- No toca inventory_movements ni create_pos_sale: los kilos siguen exactamente igual. Los triggers de venta
-- nunca pueden frenar una venta (si algo falla, ese paquete no se cuenta, la venta pasa igual).
-- Solo se ve con companies.features 'paquetes'. Un producto empieza a contar paquetes con su primer "Contar".

alter table public.products add column if not exists track_packages boolean not null default false;

create table if not exists public.product_package_moves (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  product_id uuid not null references public.products(id),
  delta integer not null,
  kind text not null check (kind in ('envasado', 'conteo', 'venta', 'anulacion')),
  reference_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists product_package_moves_product on public.product_package_moves (company_id, branch_id, product_id);
create index if not exists product_package_moves_reference on public.product_package_moves (reference_id) where reference_id is not null;

alter table public.product_package_moves enable row level security;
drop policy if exists product_package_moves_company_read on public.product_package_moves;
create policy product_package_moves_company_read on public.product_package_moves
  for select to authenticated using (company_id = public.current_company_id());
-- Sin políticas de escritura: solo las funciones de abajo.

drop trigger if exists zz_accountant_readonly on public.product_package_moves;
create trigger zz_accountant_readonly before insert or update or delete on public.product_package_moves
  for each statement execute function public.accountant_readonly_guard();

-- Paquetes por producto de una sucursal (solo los que cuentan paquetes).
create or replace function public.list_product_packages(p_branch_id uuid)
returns table (product_id uuid, packages integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.id, coalesce((select sum(m.delta) from public.product_package_moves m
                         where m.company_id = p.company_id and m.branch_id = p_branch_id and m.product_id = p.id), 0)::integer
  from public.products p
  where p.company_id = public.current_company_id() and p.track_packages
    and exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = p.company_id);
$$;

-- Envasé N paquetes (suma) o Contar (deja el número contado). Dueño o administrador.
create or replace function public.register_product_packages(p_branch_id uuid, p_product_id uuid, p_kind text, p_count integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_current integer;
  v_delta integer;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;
  if v_profile.role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador cargan paquetes'; end if;
  if p_kind not in ('envasado', 'conteo') then raise exception 'Tipo inválido'; end if;
  if p_count is null or p_count < 0 or (p_kind = 'envasado' and p_count = 0) then raise exception 'Cantidad de paquetes inválida'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_profile.company_id) then
    raise exception 'Sucursal inválida';
  end if;
  perform 1 from public.products where id = p_product_id and company_id = v_profile.company_id for update;
  if not found then raise exception 'Producto inválido'; end if;

  select coalesce(sum(delta), 0) into v_current from public.product_package_moves
  where company_id = v_profile.company_id and branch_id = p_branch_id and product_id = p_product_id;
  v_delta := case when p_kind = 'envasado' then p_count else p_count - v_current end;

  update public.products set track_packages = true where id = p_product_id and not track_packages;
  if v_delta <> 0 or p_kind = 'conteo' then
    insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, created_by)
    values (v_profile.company_id, p_branch_id, p_product_id, v_delta, p_kind, v_user_id);
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, p_branch_id, v_user_id, 'product.packages', 'product', p_product_id::text,
          jsonb_build_object('kind', p_kind, 'count', p_count, 'before', v_current, 'after', v_current + v_delta));
  return v_current + v_delta;
end;
$$;

-- Venta de Mostrador: resta paquetes. Nunca frena la venta.
create or replace function public.pos_sale_items_packages()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_unit text;
  v_tracks boolean;
  v_count integer;
begin
  if new.product_id is null then return null; end if;
  begin
    select unit, track_packages into v_unit, v_tracks from public.products where id = new.product_id;
    if not coalesce(v_tracks, false) then return null; end if;
    v_count := case
      when coalesce(new.scale_tickets, 0) > 0 then new.scale_tickets
      when v_unit = 'kg' then 1
      else greatest(round(new.quantity)::integer, 1)
    end;
    insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, reference_id, created_by)
    select s.company_id, s.branch_id, new.product_id, -v_count, 'venta', s.id, s.created_by
    from public.pos_sales s where s.id = new.sale_id;
  exception when others then
    null; -- un paquete sin contar es mejor que una venta frenada
  end;
  return null;
end;
$$;

drop trigger if exists pos_sale_items_packages on public.pos_sale_items;
create trigger pos_sale_items_packages after insert on public.pos_sale_items
  for each row execute function public.pos_sale_items_packages();

-- Anular la venta devuelve sus paquetes. Nunca frena la anulación.
create or replace function public.pos_sales_void_packages()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.voided_at is null and new.voided_at is not null then
    begin
      insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, reference_id, created_by)
      select m.company_id, m.branch_id, m.product_id, -m.delta, 'anulacion', m.reference_id, new.voided_by
      from public.product_package_moves m
      where m.reference_id = new.id and m.kind = 'venta';
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists pos_sales_void_packages on public.pos_sales;
create trigger pos_sales_void_packages after update of voided_at on public.pos_sales
  for each row execute function public.pos_sales_void_packages();

revoke all on function public.list_product_packages(uuid) from public, anon;
grant execute on function public.list_product_packages(uuid) to authenticated;
revoke all on function public.register_product_packages(uuid, uuid, text, integer) from public, anon;
grant execute on function public.register_product_packages(uuid, uuid, text, integer) to authenticated;
revoke all on function public.pos_sale_items_packages() from public, anon, authenticated;
revoke all on function public.pos_sales_void_packages() from public, anon, authenticated;

insert into public.schema_migrations (version) values ('157_product_packages') on conflict do nothing;
