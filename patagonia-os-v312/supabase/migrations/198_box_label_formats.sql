-- 198: Etiquetas de cajas envasadas al vacío. Pantalla a pedido 'etiquetas_caja' (companies.features), cualquier plan:
-- por ahora solo Carplat (decisión del dueño 16/11/2026). Se prende desde el panel de plataforma.
--
-- Pedido real (Carplat S.A., 16/11/2026): sus cajas traen una etiqueta EAN-13 con el producto y el peso neto
-- ("0 711012 717328" = Roast beef 17,320 kg) y Mostrador no la leía: no empieza con 2 como las de balanza.
-- Cada empresa con la clave guarda los formatos de las cajas que recibe o arma (uno por frigorífico). El formato se aprende en la
-- web escaneando dos cajas (box-label.ts); acá solo se guarda. Mostrador lee la caja como producto + kilos, por el
-- camino de siempre (create_pos_sale no cambia).

-- ¿La empresa de quien llama tiene la pantalla? Solo habla de la empresa propia: se puede exponer.
create or replace function public.box_labels_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.companies where id = public.current_company_id() and 'etiquetas_caja' = any(features));
$$;
revoke all on function public.box_labels_enabled() from public, anon;
grant execute on function public.box_labels_enabled() to authenticated;

create table if not exists public.box_label_formats (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  total_length int not null check (total_length between 8 and 20),
  product_start int not null check (product_start >= 0),
  product_length int not null check (product_length between 1 and 8),
  fixed_start int not null default 0 check (fixed_start >= 0),
  fixed_text text not null default '' check (fixed_text ~ '^[0-9]*$'),
  weight_start int not null check (weight_start >= 0),
  weight_length int not null check (weight_length between 3 and 7),
  weight_divisor int not null check (weight_divisor in (1, 10, 100, 1000)),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (product_start + product_length <= total_length),
  check (fixed_start + length(fixed_text) <= total_length),
  check (weight_start + weight_length <= total_length)
);
create index if not exists box_label_formats_company on public.box_label_formats (company_id);

alter table public.box_label_formats enable row level security;
revoke all on public.box_label_formats from anon, authenticated;
grant select on public.box_label_formats to authenticated;
drop policy if exists box_label_formats_company_read on public.box_label_formats;
create policy box_label_formats_company_read on public.box_label_formats for select to authenticated
  using (company_id = public.current_company_id());

-- Sin la clave, la tabla se lee vacía.
drop policy if exists etiquetas_caja on public.box_label_formats;
create policy etiquetas_caja on public.box_label_formats as restrictive for all to authenticated
  using (public.box_labels_enabled()) with check (public.box_labels_enabled());

-- El Contador no escribe nada (migración 155).
drop trigger if exists zz_accountant_readonly on public.box_label_formats;
create trigger zz_accountant_readonly before insert or update or delete on public.box_label_formats
  for each statement execute function public.accountant_readonly_guard();

-- Guardar (nuevo si p_id es null). Dueño, administrador y encargado (los que cargan productos).
create or replace function public.save_box_label_format(
  p_id uuid, p_name text, p_total_length int, p_product_start int, p_product_length int,
  p_fixed_start int, p_fixed_text text, p_weight_start int, p_weight_length int, p_weight_divisor int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_id uuid;
begin
  perform public.require_role(array['owner', 'admin', 'manager']);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not public.box_labels_enabled() then raise exception 'Las etiquetas de cajas no están habilitadas para este negocio. Pedíselo a soporte de Patagonia.'; end if;

  if p_id is null then
    if (select count(*) from public.box_label_formats where company_id = v_company) >= 20 then
      raise exception 'Ya hay 20 formatos de cajas cargados. Borrá uno que no uses.';
    end if;
    insert into public.box_label_formats (company_id, name, total_length, product_start, product_length, fixed_start, fixed_text,
      weight_start, weight_length, weight_divisor, created_by)
    values (v_company, btrim(p_name), p_total_length, p_product_start, p_product_length, p_fixed_start, coalesce(p_fixed_text, ''),
      p_weight_start, p_weight_length, p_weight_divisor, v_user)
    returning id into v_id;
  else
    update public.box_label_formats set name = btrim(p_name), total_length = p_total_length, product_start = p_product_start,
      product_length = p_product_length, fixed_start = p_fixed_start, fixed_text = coalesce(p_fixed_text, ''),
      weight_start = p_weight_start, weight_length = p_weight_length, weight_divisor = p_weight_divisor
    where id = p_id and company_id = v_company
    returning id into v_id;
    if v_id is null then raise exception 'Formato no encontrado'; end if;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_user, 'box_label_format.save', 'box_label_format', v_id::text, jsonb_build_object(
    'name', btrim(p_name), 'total_length', p_total_length, 'product', jsonb_build_array(p_product_start, p_product_length),
    'fixed', coalesce(p_fixed_text, ''), 'weight', jsonb_build_array(p_weight_start, p_weight_length, p_weight_divisor)));
  return v_id;
end;
$$;

create or replace function public.delete_box_label_format(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_name text;
begin
  perform public.require_role(array['owner', 'admin', 'manager']);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not public.box_labels_enabled() then raise exception 'Las etiquetas de cajas no están habilitadas para este negocio. Pedíselo a soporte de Patagonia.'; end if;
  delete from public.box_label_formats where id = p_id and company_id = v_company returning name into v_name;
  if v_name is null then raise exception 'Formato no encontrado'; end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_user, 'box_label_format.delete', 'box_label_format', p_id::text, jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.save_box_label_format(uuid, text, int, int, int, int, text, int, int, int) from public, anon;
revoke all on function public.delete_box_label_format(uuid) from public, anon;
grant execute on function public.save_box_label_format(uuid, text, int, int, int, int, text, int, int, int) to authenticated;
grant execute on function public.delete_box_label_format(uuid) to authenticated;

-- La clave en la lista de pantallas a pedido del panel de plataforma: se agrega a la definición VIVA (como 193/197),
-- así no se pisa una clave que se haya sumado después.
do $mig$
declare
  v_def text := pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure);
begin
  if position('''etiquetas_caja''' in v_def) > 0 then return; end if;
  if position('''pedidos_tienda'')' in v_def) = 0 then raise exception 'set_company_feature no tiene la lista esperada'; end if;
  execute replace(v_def, '''pedidos_tienda'')', '''pedidos_tienda'', ''etiquetas_caja'')');
end
$mig$;

insert into public.schema_migrations (version) values ('198_box_label_formats') on conflict do nothing;
