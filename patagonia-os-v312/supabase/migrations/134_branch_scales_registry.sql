-- 134: varias balanzas por sucursal, cada una con su nombre (19/10/2026).
--
-- Por qué: hasta ahora todo suponía UNA balanza. scale_profiles ya tenía la clave (empresa, sucursal, scale_key),
-- pero la app escribía siempre scale_key = 'systel', así que una segunda Systel pisaba a la primera, y la Kretz no
-- se registraba en ningún lado (vivía solo en la computadora). Ver docs/BALANZAS_DIAGNOSTICO_2026-10-19.md.
--
-- Qué cambia:
-- 1. scale_profiles pasa a ser el registro de balanzas de la sucursal: nombre que elige el cliente ("Mostrador",
--    "Balanza del fondo"), familia (systel / kretz), identidad que contesta la balanza (número de balanza, letra de
--    equipo) para reconocerla aunque haya dos iguales, y cuándo se conectó por última vez.
-- 2. register_branch_scale: alta o reconexión (owner/admin). Sin clave = balanza nueva, la clave la genera el
--    servidor. Con clave = la misma balanza: actualiza modelo, identidad y última conexión; el nombre no se toca.
-- 3. rename_branch_scale / remove_branch_scale.
--
-- Qué NO cambia:
-- - Mostrador sigue usando solo las balanzas con formato de códigos (weighed/unit/total_format); una Kretz
--   registrada acá no tiene formatos y no cambia nada en la venta.
-- - save_scale_catalog, set_scale_links, create_pos_scale_sale: iguales. Los papeles ya cobrados quedan.
-- - La fila existente de Los gringos ('systel') se conserva con su clave: solo recibe nombre y familia.

alter table public.scale_profiles add column if not exists name text;
alter table public.scale_profiles add column if not exists family text;
alter table public.scale_profiles add column if not exists identity jsonb not null default '{}'::jsonb;
alter table public.scale_profiles add column if not exists last_seen_at timestamptz;
alter table public.scale_profiles add column if not exists created_at timestamptz not null default now();

update public.scale_profiles
set family = case when brand ilike 'kretz%' then 'kretz' else 'systel' end
where family is null;

update public.scale_profiles
set name = left(trim(initcap(brand) || ' ' || coalesce(model, '')), 40)
where name is null or trim(name) = '';

alter table public.scale_profiles alter column family set default 'systel';
alter table public.scale_profiles alter column family set not null;
alter table public.scale_profiles drop constraint if exists scale_profiles_family_check;
alter table public.scale_profiles add constraint scale_profiles_family_check check (family in ('systel', 'kretz'));

-- Alta o reconexión de una balanza en una sucursal.
create or replace function public.register_branch_scale(
  p_branch_id uuid,
  p_scale_key text,
  p_name text,
  p_family text,
  p_brand text,
  p_model text,
  p_identity jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_key text := nullif(trim(coalesce(p_scale_key, '')), '');
  v_name text := left(nullif(trim(coalesce(p_name, '')), ''), 40);
  v_new boolean;
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede agregar una balanza'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company and active = true) then raise exception 'Sucursal inválida'; end if;
  if p_family is null or p_family not in ('systel', 'kretz') then raise exception 'Marca de balanza inválida'; end if;
  if p_identity is not null and jsonb_typeof(p_identity) <> 'object' then raise exception 'Identidad inválida'; end if;

  if v_key is null then
    v_key := p_family || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  elsif v_key !~ '^[a-z0-9-]{1,60}$' then
    raise exception 'Clave de balanza inválida';
  end if;

  v_new := not exists (select 1 from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = v_key);

  insert into public.scale_profiles (company_id, branch_id, scale_key, brand, model, name, family, identity, last_seen_at, updated_by, updated_at)
  values (v_company, p_branch_id, v_key, coalesce(nullif(trim(p_brand), ''), p_family), nullif(trim(coalesce(p_model, '')), ''),
          coalesce(v_name, initcap(p_family)), p_family, coalesce(p_identity, '{}'::jsonb), now(), v_user, now())
  on conflict (company_id, branch_id, scale_key) do update set
    family = excluded.family,
    model = coalesce(excluded.model, scale_profiles.model),
    -- La identidad solo se completa: nunca se borra con una lectura que no la trajo.
    identity = scale_profiles.identity || excluded.identity,
    -- El nombre lo elige el cliente: una reconexión no lo cambia.
    name = coalesce(scale_profiles.name, excluded.name),
    last_seen_at = now(),
    updated_by = v_user,
    updated_at = now();

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, case when v_new then 'scale.register' else 'scale.reconnect' end, 'scale_profile', v_key,
          jsonb_build_object('family', p_family, 'brand', p_brand, 'model', p_model, 'identity', p_identity, 'name', v_name));
  return v_key;
end;
$$;

create or replace function public.rename_branch_scale(p_branch_id uuid, p_scale_key text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_name text := left(nullif(trim(coalesce(p_name, '')), ''), 40);
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede cambiar esto'; end if;
  if v_name is null then raise exception 'Escribí un nombre para la balanza'; end if;
  update public.scale_profiles set name = v_name, updated_by = v_user, updated_at = now()
  where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key;
  if not found then raise exception 'La balanza no está en esa sucursal'; end if;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale.rename', 'scale_profile', p_scale_key, jsonb_build_object('name', v_name));
end;
$$;

-- Quitar una balanza de la sucursal. Borra su catálogo y sus vínculos (en cascada); las ventas y los papeles ya
-- cobrados quedan como estaban. En la auditoría queda una copia de lo que tenía.
create or replace function public.remove_branch_scale(p_branch_id uuid, p_scale_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_old jsonb;
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede quitar una balanza'; end if;
  select to_jsonb(p) || jsonb_build_object('links', (
           select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'kind', i.link_kind, 'product_id', i.product_id)), '[]'::jsonb)
           from public.scale_catalog_items i
           where i.company_id = p.company_id and i.branch_id = p.branch_id and i.scale_key = p.scale_key and i.link_kind <> 'none'))
    into v_old
  from public.scale_profiles p
  where p.company_id = v_company and p.branch_id = p_branch_id and p.scale_key = p_scale_key;
  if v_old is null then raise exception 'La balanza no está en esa sucursal'; end if;
  delete from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company, p_branch_id, v_user, 'scale.remove', 'scale_profile', p_scale_key, v_old);
end;
$$;

-- Detalle de un ticket de TOTAL de la balanza (Mostrador → "Detallar productos", apps/web/src/features/sale/ticket-detail.ts):
-- las líneas del detalle son del MISMO papel, así que no suman tickets en el control del cierre (104). Mostrador las
-- manda con scale_tickets = 0. Antes cualquier valor se llevaba a mínimo 1; ahora el 0 explícito se respeta.
-- Sin cambios para lo que ya se manda (1 o más, o vacío = 1).
create or replace function public.pos_item_scale_tickets(p_source text, p_count text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when public.pos_item_source(p_source) is null then null
    when p_count ~ '^[0-9]{1,6}$' then p_count::integer
    else 1
  end;
$$;

revoke all on function public.register_branch_scale(uuid, text, text, text, text, text, jsonb) from public, anon;
revoke all on function public.rename_branch_scale(uuid, text, text) from public, anon;
revoke all on function public.remove_branch_scale(uuid, text) from public, anon;
grant execute on function public.register_branch_scale(uuid, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.rename_branch_scale(uuid, text, text) to authenticated;
grant execute on function public.remove_branch_scale(uuid, text) to authenticated;

insert into public.schema_migrations (version) values ('134_branch_scales_registry') on conflict do nothing;
