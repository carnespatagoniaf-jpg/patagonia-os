-- 200: Etiquetas de cajas (198): a qué producto de Patagonia va cada número de caja.
--
-- REAL (Carplat, 17/11/2026): el número de producto de la caja (07 Roast beef, 15 Tortuguita, 01 Matambre) no es el
-- código del producto en Patagonia (219, 215, 61…), y el cliente no va a renumerar sus productos (son los de la
-- balanza). Cada formato guarda número de caja → producto. Los números del medio de su código cambian con la fecha,
-- así que la web ya no los exige (fixed_text queda vacío; la columna sigue para otros frigoríficos).

alter table public.box_label_formats add column if not exists product_map jsonb not null default '{}'::jsonb;
alter table public.box_label_formats drop constraint if exists box_label_formats_product_map_object;
alter table public.box_label_formats add constraint box_label_formats_product_map_object check (jsonb_typeof(product_map) = 'object');

-- Asociar (o con p_product_id null, soltar) un número de caja. Mismos permisos que guardar el formato (198).
create or replace function public.set_box_label_product(p_format_id uuid, p_digits text, p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_digits text := btrim(coalesce(p_digits, ''));
  v_map jsonb;
  v_name text;
begin
  perform public.require_role(array['owner', 'admin', 'manager']);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not public.box_labels_enabled() then raise exception 'Las etiquetas de cajas no están habilitadas para este negocio. Pedíselo a soporte de Patagonia.'; end if;
  if v_digits !~ '^[0-9]{1,8}$' then raise exception 'Número de caja inválido'; end if;

  if p_product_id is not null then
    select name into v_name from public.products where id = p_product_id and company_id = v_company;
    if v_name is null then raise exception 'Producto no encontrado'; end if;
  end if;

  select product_map into v_map from public.box_label_formats where id = p_format_id and company_id = v_company for update;
  if v_map is null then raise exception 'Formato no encontrado'; end if;
  -- "07" y "7" son el mismo número de caja: se borra cualquier forma que ya estuviera.
  v_map := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_map) e(k, v)
            where k !~ '^[0-9]+$' or k::numeric <> v_digits::numeric);
  if p_product_id is not null then v_map := v_map || jsonb_build_object(v_digits, p_product_id::text); end if;
  update public.box_label_formats set product_map = v_map where id = p_format_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_user, 'box_label_format.product', 'box_label_format', p_format_id::text,
          jsonb_build_object('digits', v_digits, 'product_id', p_product_id, 'product', v_name));
  return v_map;
end;
$$;

revoke all on function public.set_box_label_product(uuid, text, uuid) from public, anon;
grant execute on function public.set_box_label_product(uuid, text, uuid) to authenticated;

insert into public.schema_migrations (version) values ('200_box_label_products') on conflict do nothing;
