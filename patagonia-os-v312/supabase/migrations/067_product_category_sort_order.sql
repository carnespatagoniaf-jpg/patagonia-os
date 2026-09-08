-- El dueño pidió que las categorías se muestren en un orden fijo elegido
-- por él (ej. "Carne" siempre primero), no alfabético -- alfabético ponía
-- "Achuras" antes que "Carne", que es al revés de cómo el carnicero
-- piensa el mostrador. Se agrega sort_order y se hace un backfill según
-- el orden en que 045_product_categories.sql ya sembraba las categorías
-- por defecto (Carne, Cerdo, Pollo, Achuras, Embutidos, Almacén, Leña y
-- Carbón, Combos) -- cualquier categoría con otro nombre (creada a mano)
-- queda después, en el orden en que se creó.
alter table public.product_categories
  add column if not exists sort_order integer not null default 0;

with priority(name, rank) as (
  values ('Carne',1),('Cerdo',2),('Pollo',3),('Achuras',4),('Embutidos',5),('Almacén',6),('Leña y Carbón',7),('Combos',8)
),
ordered as (
  select pc.id,
    row_number() over (
      partition by pc.company_id
      order by coalesce(pr.rank, 999), pc.created_at
    ) as rn
  from public.product_categories pc
  left join priority pr on pr.name = pc.name
)
update public.product_categories pc
set sort_order = ordered.rn
from ordered
where ordered.id = pc.id;

create or replace function public.create_product_category(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_category_id uuid := gen_random_uuid();
  v_name text := trim(p_name);
  v_sort_order integer;
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

  if v_name is null or length(v_name) = 0 then
    raise exception 'El nombre de la categoría es obligatorio';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_sort_order
  from public.product_categories
  where company_id = v_company_id;

  insert into public.product_categories (id, company_id, name, sort_order)
  values (v_category_id, v_company_id, v_name, v_sort_order);

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'product_category.create', 'product_category', v_category_id::text,
    jsonb_build_object('name', v_name)
  );

  return jsonb_build_object('id', v_category_id, 'name', v_name);
end;
$$;

revoke all on function public.create_product_category(text) from public;
grant execute on function public.create_product_category(text) to authenticated;

-- Sube o baja una categoría un lugar, intercambiando su sort_order con el
-- de la vecina -- así el dueño puede reordenar a mano sin drag-and-drop.
create or replace function public.reorder_product_category(p_category_id uuid, p_direction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sort_order integer;
  v_neighbor_id uuid;
  v_neighbor_sort_order integer;
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

  if p_direction not in ('up', 'down') then
    raise exception 'Dirección inválida';
  end if;

  select sort_order into v_sort_order
  from public.product_categories
  where id = p_category_id and company_id = v_company_id
  for update;

  if v_sort_order is null then
    raise exception 'Categoría inválida';
  end if;

  if p_direction = 'up' then
    select id, sort_order into v_neighbor_id, v_neighbor_sort_order
    from public.product_categories
    where company_id = v_company_id and sort_order < v_sort_order
    order by sort_order desc
    limit 1
    for update;
  else
    select id, sort_order into v_neighbor_id, v_neighbor_sort_order
    from public.product_categories
    where company_id = v_company_id and sort_order > v_sort_order
    order by sort_order asc
    limit 1
    for update;
  end if;

  if v_neighbor_id is null then
    return;
  end if;

  update public.product_categories set sort_order = v_neighbor_sort_order where id = p_category_id;
  update public.product_categories set sort_order = v_sort_order where id = v_neighbor_id;
end;
$$;

revoke all on function public.reorder_product_category(uuid, text) from public;
grant execute on function public.reorder_product_category(uuid, text) to authenticated;
