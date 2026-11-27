-- 214: Freezer (pedido del dueño, 26/11/2026): saber qué hay guardado en el freezer de cada local y que salga solo
-- cuando se vende.
--
-- Pantalla a pedido 'freezer' (companies.features, se prende desde el panel de plataforma, "Pantallas a pedido").
--
-- Cómo se usa (decisión del dueño: con la etiqueta de la balanza, sin impresora aparte):
--   * Se pesa el producto en la balanza como siempre y se pega la etiqueta en la bolsa.
--   * Stock → Freezer → "Guardar": se escanea esa etiqueta (o se elige el producto y se escriben los kilos). Cada
--     escaneo es un paquete: freezer_packages con el producto, los kilos y el código de la etiqueta.
--   * Guardar NO mueve stock: la mercadería ya estaba en el stock del local, el freezer es dónde está.
--   * En Mostrador, una etiqueta que está en el freezer de ese local entra como su propia línea con los kilos que se
--     guardaron, al precio de hoy, y viaja como pos_sale_items.scale_ticket = 'FRZ-' + código, sin importe (como los
--     paquetes de Planta y las cajas: create_pos_sale NO se tocó). El trigger freezer_packages_on_sale marca vendido
--     el paquete guardado más viejo con ese código y ese producto, en ese local. Anular la venta lo devuelve.
--   * "Sacar" (se usó en el local, se tiró, se mandó a otro lado) lo marca sacado, con el motivo.
-- Dos bolsas del mismo producto con exactamente el mismo peso tienen el mismo código: es normal, cada venta saca una.
--
-- Lectura: RLS por empresa + restrictiva con la pantalla prendida. Escritura: solo las funciones de abajo.

create table if not exists public.freezer_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  product_id uuid not null references public.products(id),
  quantity numeric not null check (quantity > 0),
  code text,
  status text not null default 'guardado' check (status in ('guardado', 'vendido', 'sacado')),
  stored_at timestamptz not null default now(),
  stored_by uuid,
  out_at timestamptz,
  out_by uuid,
  out_reason text,
  pos_sale_id uuid references public.pos_sales(id) on delete set null
);
create index if not exists freezer_packages_branch on public.freezer_packages (company_id, branch_id, status, stored_at);
create index if not exists freezer_packages_code on public.freezer_packages (company_id, branch_id, code) where status = 'guardado';
create index if not exists freezer_packages_sale on public.freezer_packages (pos_sale_id) where pos_sale_id is not null;

create or replace function public.freezer_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select 'freezer' = any(c.features) from public.companies c where c.id = public.current_company_id()), false);
$$;
revoke all on function public.freezer_enabled() from public, anon;
grant execute on function public.freezer_enabled() to authenticated;

alter table public.freezer_packages enable row level security;
drop policy if exists freezer_packages_company_read on public.freezer_packages;
create policy freezer_packages_company_read on public.freezer_packages
  for select to authenticated using (company_id = public.current_company_id());
drop policy if exists freezer_packages_feature on public.freezer_packages;
create policy freezer_packages_feature on public.freezer_packages
  as restrictive for select to authenticated using (public.freezer_enabled());
-- Sin políticas de escritura: solo las funciones de abajo.

drop trigger if exists zz_accountant_readonly on public.freezer_packages;
create trigger zz_accountant_readonly before insert or update or delete on public.freezer_packages
  for each statement execute function public.accountant_readonly_guard();

-- Quién llama: perfil activo, empresa con la pantalla, rol del local, y (salvo dueño/administrador) su local.
create or replace function public.freezer_caller(p_branch_id uuid, out company_id uuid, out user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid() and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;
  if v_profile.role not in ('owner', 'admin', 'manager', 'production', 'cashier') then
    raise exception 'No tenés permiso para el freezer';
  end if;
  if not exists (select 1 from public.companies c where c.id = v_profile.company_id and 'freezer' = any(c.features)) then
    raise exception 'La pantalla Freezer no está prendida para tu empresa';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = v_profile.company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if v_profile.role not in ('owner', 'admin') and not public.my_branch_allowed(p_branch_id) then
    raise exception 'Solo podés usar el freezer de tu local';
  end if;
  company_id := v_profile.company_id;
  user_id := v_profile.id;
end;
$$;
revoke all on function public.freezer_caller(uuid) from public, anon, authenticated;

-- p_items: [{product_id, quantity, code?}] — un renglón por paquete.
create or replace function public.freezer_store(p_branch_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_code text;
  v_count integer := 0;
  v_kg numeric := 0;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  select * into c from public.freezer_caller(p_branch_id);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay nada para guardar';
  end if;
  if jsonb_array_length(p_items) > 300 then raise exception 'Máximo 300 paquetes por vez'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
    where id = (v_item->>'product_id')::uuid and company_id = c.company_id;
    if v_product.id is null then raise exception 'Producto inválido'; end if;
    v_qty := round((v_item->>'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 or v_qty > 500 then
      raise exception 'Cantidad inválida para %', v_product.name;
    end if;
    if v_product.unit <> 'kg' and v_qty <> round(v_qty) then
      raise exception '% se cuenta por unidad: la cantidad tiene que ser entera', v_product.name;
    end if;
    v_code := nullif(left(btrim(coalesce(v_item->>'code', '')), 40), '');

    insert into public.freezer_packages (company_id, branch_id, product_id, quantity, code, stored_by)
    values (c.company_id, p_branch_id, v_product.id, v_qty, v_code, c.user_id)
    returning id into v_id;
    v_ids := v_ids || v_id;
    v_count := v_count + 1;
    if v_product.unit = 'kg' then v_kg := v_kg + v_qty; end if;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_branch_id, c.user_id, 'freezer.store', 'freezer_packages', null,
          jsonb_build_object('branch_id', p_branch_id, 'packages', v_count, 'kg', v_kg, 'ids', to_jsonb(v_ids)));

  return jsonb_build_object('packages', v_count, 'kg', v_kg);
end;
$$;
revoke all on function public.freezer_store(uuid, jsonb) from public, anon;
grant execute on function public.freezer_store(uuid, jsonb) to authenticated;

-- Sacar a mano (se usó en el local, se tiró, se mandó a otro lado, se cargó por error).
create or replace function public.freezer_take_out(p_package_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
  c record;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 120), '');
  v_count integer;
begin
  if p_package_ids is null or cardinality(p_package_ids) = 0 then raise exception 'No elegiste ningún paquete'; end if;
  if v_reason is null then raise exception 'Escribí por qué sale del freezer'; end if;
  -- Todos del mismo local (el que se valida).
  select min(branch_id::text)::uuid into v_branch from public.freezer_packages where id = any(p_package_ids);
  if v_branch is null then raise exception 'Paquete inválido'; end if;
  if exists (select 1 from public.freezer_packages where id = any(p_package_ids) and branch_id <> v_branch) then
    raise exception 'Los paquetes tienen que ser del mismo local';
  end if;
  select * into c from public.freezer_caller(v_branch);

  update public.freezer_packages
  set status = 'sacado', out_at = now(), out_by = c.user_id, out_reason = v_reason
  where id = any(p_package_ids) and company_id = c.company_id and status = 'guardado';
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'Esos paquetes ya no están en el freezer'; end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_branch, c.user_id, 'freezer.take_out', 'freezer_packages', null,
          jsonb_build_object('branch_id', v_branch, 'packages', v_count, 'reason', v_reason, 'ids', to_jsonb(p_package_ids)));
  return v_count;
end;
$$;
revoke all on function public.freezer_take_out(uuid[], text) from public, anon;
grant execute on function public.freezer_take_out(uuid[], text) to authenticated;

-- Deshacer un "Sacar" (se sacó el paquete equivocado). Solo lo sacado a mano, nunca lo vendido (eso se anula la venta).
create or replace function public.freezer_put_back(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
  c record;
begin
  select branch_id into v_branch from public.freezer_packages where id = p_package_id;
  if v_branch is null then raise exception 'Paquete inválido'; end if;
  select * into c from public.freezer_caller(v_branch);
  update public.freezer_packages
  set status = 'guardado', out_at = null, out_by = null, out_reason = null
  where id = p_package_id and company_id = c.company_id and status = 'sacado';
  if not found then raise exception 'Ese paquete no se puede volver a guardar (solo lo que se sacó a mano)'; end if;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_branch, c.user_id, 'freezer.put_back', 'freezer_packages', p_package_id, jsonb_build_object('branch_id', v_branch));
end;
$$;
revoke all on function public.freezer_put_back(uuid) from public, anon;
grant execute on function public.freezer_put_back(uuid) to authenticated;

-- Venta en Mostrador: la línea del freezer trae scale_ticket 'FRZ-' + código. Se marca vendido el paquete guardado más
-- viejo con ese código y ese producto en el local de la venta. Nunca frena la venta.
create or replace function public.freezer_packages_on_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    update public.freezer_packages p
    set status = 'vendido', pos_sale_id = new.sale_id, out_at = now(), out_by = s.created_by
    from public.pos_sales s
    where s.id = new.sale_id
      and p.id = (
        select f.id from public.freezer_packages f
        where f.company_id = s.company_id and f.branch_id = s.branch_id and f.status = 'guardado'
          and f.code = substr(new.scale_ticket, 5) and f.product_id is not distinct from new.product_id
        order by f.stored_at, f.id
        limit 1
        for update skip locked
      );
  exception when others then
    null; -- un paquete sin marcar es mejor que una venta frenada
  end;
  return null;
end;
$$;
revoke all on function public.freezer_packages_on_sale() from public, anon, authenticated;

drop trigger if exists freezer_packages_on_sale on public.pos_sale_items;
create trigger freezer_packages_on_sale after insert on public.pos_sale_items
  for each row when (new.scale_ticket like 'FRZ-%') execute function public.freezer_packages_on_sale();

-- Anular la venta devuelve los paquetes al freezer.
create or replace function public.freezer_packages_on_sale_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.voided_at is null and new.voided_at is not null then
    begin
      update public.freezer_packages set status = 'guardado', pos_sale_id = null, out_at = null, out_by = null
      where pos_sale_id = new.id and status = 'vendido';
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;
revoke all on function public.freezer_packages_on_sale_void() from public, anon, authenticated;

drop trigger if exists freezer_packages_on_sale_void on public.pos_sales;
create trigger freezer_packages_on_sale_void after update of voided_at on public.pos_sales
  for each row execute function public.freezer_packages_on_sale_void();

-- La clave nueva en la lista de set_company_feature, inyectada en la definición viva (como la 211): la lista termina en
-- 'pedidos_tienda', 'etiquetas_caja' o 'precios_excel' según la base (staging no tiene la 198 ni la 211 en esta función).
do $mig$
declare
  v_def text := pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure);
begin
  if position('''freezer''' in v_def) > 0 then return; end if;
  if v_def !~ '''pedidos_tienda''(, ''etiquetas_caja'')?(, ''precios_excel'')?\)' then
    raise exception 'set_company_feature no tiene la lista esperada';
  end if;
  execute regexp_replace(v_def, '(''pedidos_tienda''(, ''etiquetas_caja'')?(, ''precios_excel'')?)\)', '\1, ''freezer'')');
end
$mig$;

insert into public.schema_migrations (version) values ('214_freezer') on conflict do nothing;
