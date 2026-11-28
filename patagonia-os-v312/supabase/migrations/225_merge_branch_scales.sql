-- 225: unir los registros repetidos de una misma balanza (plan balanzas v2, después de la etapa 1). 27/11/2026.
--
-- Por qué: hasta la etapa 1, "Agregar balanza" registraba SIEMPRE otra fila, aunque fuera la misma balanza (la
-- identidad que contesta la balanza es débil: dos Systel de fábrica dicen las dos {"address":20}). En producción
-- (26/11): Los gringos 4 × {"address":20}, Carnes premium 3, Expo Carnes 2, Mercado de la Cruz 2, El Abastero 2 ×
-- {"letter":"C","equipment":"01"}, Oliem 2. Desde la etapa 1 ya no se crean nuevos (connect-branch.ts pregunta
-- "¿Es la X?"); esto arregla los que ya están.
--
-- Qué agrega:
-- 1. scale_profiles.merged_into: el registro se unió a otro (queda active = false, NO se borra).
--    scale_profiles.not_same_as: claves que el dueño dijo que son balanzas distintas ("Son distintas": no se vuelve
--    a preguntar por ese grupo).
-- 2. list_duplicate_scale_candidates(sucursal): grupos de registros SIN unir de la misma familia y la misma identidad
--    (no vacía), salvo que el dueño ya haya dicho que son distintas. Con el último uso (última conexión o envío).
-- 3. merge_branch_scales(sucursal, queda, unir[]): pasa al que queda TODO lo que apunta por scale_key:
--    - scale_catalog_items: el que queda conserva lo suyo; los números que no tiene se pasan (el vinculado y leído más
--      reciente); si el suyo no está vinculado y el otro sí, toma el vínculo. Lo que sobra (repetido) se borra y queda
--      copiado en audit_log.
--    - pos_scale_paper_claims: pasan todos. Si el mismo papel quedó cobrado en dos registros el mismo día, se
--      renumera la vez (occurrence) por orden de cobro: create_pos_scale_sale sigue con max + 1.
--    - scale_jobs (220): pasan todos (scale_job_items cuelga del trabajo, no de la clave).
--    - install (165): se queda con lo más reciente (se mezclan del más viejo al más nuevo por última conexión).
--    - identidad, última conexión, "son distintas" y los formatos de etiqueta que le falten al que queda.
--    - registros que ya se habían unido a uno de estos pasan a apuntar al que queda.
--    Si los formatos de etiqueta (weighed/unit/total_format) son DISTINTOS entre los registros, NO une nada y devuelve
--    el detalle: pueden ser balanzas físicas distintas (Mostrador lee cada una con su formato).
--    Dueño o administrador (como agregar/quitar balanzas, 134). Queda en audit_log ('scale.merge').
-- 4. mark_scales_distinct(sucursal, claves[]): "Son distintas". Dueño o administrador. Queda en audit_log.
--
-- Qué NO cambia: register_branch_scale y la venta. Una computadora que todavía recuerde la clave unida la redirige
-- sola al que queda (web, local-bindings.ts). Sin escrituras directas (175): todo por estas funciones.
-- No cambia ningún dato al aplicarse. Vuelta atrás: 225_merge_branch_scales.rollback.sql.

alter table public.scale_profiles add column if not exists merged_into text;
alter table public.scale_profiles add column if not exists not_same_as text[] not null default '{}';
alter table public.scale_profiles drop constraint if exists scale_profiles_merged_into_check;
alter table public.scale_profiles add constraint scale_profiles_merged_into_check
  check (merged_into is null or (merged_into <> scale_key and active = false));

-- ------------------------------------------------------------------------------------------------- candidatos
create or replace function public.list_duplicate_scale_candidates(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_out jsonb;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = auth.uid() and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;

  with live as (
    select p.*,
           greatest(p.last_seen_at, (select max(j.started_at) from public.scale_jobs j
                                     where j.company_id = p.company_id and j.branch_id = p.branch_id and j.scale_key = p.scale_key)) as last_used_at
    from public.scale_profiles p
    where p.company_id = v_company and p.branch_id = p_branch_id and p.merged_into is null
      and p.identity <> '{}'::jsonb
  ),
  groups as (
    select l.family, l.identity
    from live l
    group by l.family, l.identity
    having count(*) > 1
       -- Si el dueño ya dijo que TODAS son distintas entre sí, no se vuelve a preguntar.
       and exists (
         select 1 from live a join live b on a.family = b.family and a.identity = b.identity and a.scale_key < b.scale_key
         where a.family = l.family and a.identity = l.identity
           and not (b.scale_key = any (a.not_same_as) or a.scale_key = any (b.not_same_as)))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'family', g.family,
           'identity', g.identity,
           'formats_differ', (
             select count(distinct l.weighed_format) > 1 or count(distinct l.unit_format) > 1 or count(distinct l.total_format) > 1
             from live l where l.family = g.family and l.identity = g.identity),
           'scales', (
             select jsonb_agg(jsonb_build_object(
                      'scale_key', l.scale_key, 'name', l.name, 'brand', l.brand, 'model', l.model, 'active', l.active,
                      'last_seen_at', l.last_seen_at, 'last_used_at', l.last_used_at,
                      'weighed_format', l.weighed_format, 'unit_format', l.unit_format, 'total_format', l.total_format)
                    order by l.last_used_at desc nulls last, l.scale_key)
             from live l where l.family = g.family and l.identity = g.identity)
         ) order by g.family, g.identity::text), '[]'::jsonb)
    into v_out
  from groups g;
  return v_out;
end;
$$;

-- ------------------------------------------------------------------------------------------------- unir
create or replace function public.merge_branch_scales(p_branch_id uuid, p_keep_key text, p_merge_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_keys text[];
  v_all text[];
  v_keep public.scale_profiles%rowtype;
  v_found int;
  v_detail jsonb;
  v_row record;
  v_install jsonb := '{}'::jsonb;
  v_identity jsonb := '{}'::jsonb;
  v_not_same text[] := '{}';
  v_seen timestamptz;
  v_src public.scale_profiles%rowtype;
  v_items_moved int := 0;
  v_items_linked int := 0;
  v_items_removed jsonb;
  v_claims int := 0;
  v_jobs int := 0;
  v_repointed int := 0;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  if v_user is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;
  if p_keep_key is null or length(btrim(p_keep_key)) = 0 then raise exception 'Elegí cuál registro queda'; end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys
  from unnest(coalesce(p_merge_keys, '{}')) k
  where k is not null and length(btrim(k)) > 0 and k <> p_keep_key;
  if cardinality(v_keys) = 0 then raise exception 'Elegí qué registros unir'; end if;
  if cardinality(v_keys) > 20 then raise exception 'Hasta 20 registros por vez'; end if;
  v_all := v_keys || p_keep_key;

  -- Candado sobre todos los registros, siempre en el mismo orden.
  perform 1 from public.scale_profiles
  where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_all)
  order by scale_key
  for update;

  select * into v_keep from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = p_keep_key;
  if v_keep.scale_key is null then raise exception 'La balanza que queda no está en esa sucursal'; end if;
  if v_keep.merged_into is not null then raise exception 'La balanza que queda ya se unió a otra'; end if;
  select count(*) into v_found from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys);
  if v_found <> cardinality(v_keys) then raise exception 'Alguno de esos registros no está en la sucursal'; end if;
  if exists (select 1 from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys) and merged_into is not null) then
    raise exception 'Alguno de esos registros ya se unió a otro';
  end if;
  if exists (select 1 from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys) and family <> v_keep.family) then
    raise exception 'Son de marcas distintas: no se pueden unir';
  end if;

  -- Formatos de etiqueta distintos = pueden ser balanzas físicas distintas: no se une nada.
  if exists (
    select 1 from public.scale_profiles
    where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_all)
    having count(distinct weighed_format) > 1 or count(distinct unit_format) > 1 or count(distinct total_format) > 1
  ) then
    select jsonb_agg(jsonb_build_object('scale_key', scale_key, 'name', name, 'weighed_format', weighed_format,
                                        'unit_format', unit_format, 'total_format', total_format) order by scale_key)
      into v_detail
    from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_all);
    return jsonb_build_object('merged', false, 'reason', 'formatos_distintos', 'detail', v_detail);
  end if;

  -- Ficha del que queda: install con lo más reciente, identidad, última conexión, "son distintas".
  for v_row in
    select * from public.scale_profiles
    where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_all)
    order by coalesce(last_seen_at, updated_at, created_at) asc nulls first, (scale_key = p_keep_key)
  loop
    v_install := v_install || coalesce(v_row.install, '{}'::jsonb);
    v_identity := v_identity || coalesce(v_row.identity, '{}'::jsonb);
    v_not_same := v_not_same || coalesce(v_row.not_same_as, '{}');
    v_seen := greatest(v_seen, v_row.last_seen_at);
  end loop;
  -- La identidad del que queda manda sobre la de los otros.
  v_identity := v_identity || coalesce(v_keep.identity, '{}'::jsonb);
  select coalesce(array_agg(distinct k), '{}') into v_not_same from unnest(v_not_same) k where not (k = any (v_all));

  -- Formatos que le faltan al que queda (los que tiene son iguales: se comprobó arriba). Del más reciente que los tenga.
  select * into v_src from public.scale_profiles
  where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys)
    and (weighed_format is not null or unit_format is not null or total_format is not null)
  order by coalesce(last_seen_at, read_at, updated_at) desc nulls last, scale_key
  limit 1;

  update public.scale_profiles p
     set install = v_install,
         identity = v_identity,
         last_seen_at = v_seen,
         not_same_as = v_not_same,
         weighed_format = coalesce(p.weighed_format, v_src.weighed_format),
         unit_format = coalesce(p.unit_format, v_src.unit_format),
         total_format = coalesce(p.total_format, v_src.total_format),
         -- Si el que queda no leía etiquetas y el otro sí, Mostrador las sigue leyendo igual que antes.
         amount_decimals = case when p.weighed_format is null and p.unit_format is null and p.total_format is null and v_src.scale_key is not null then v_src.amount_decimals else p.amount_decimals end,
         generic_codes = case when p.weighed_format is null and p.unit_format is null and p.total_format is null and v_src.scale_key is not null then v_src.generic_codes else p.generic_codes end,
         read_at = case when p.weighed_format is null and p.unit_format is null and p.total_format is null and v_src.scale_key is not null then v_src.read_at else p.read_at end,
         active = case when p.weighed_format is null and p.unit_format is null and p.total_format is null and v_src.scale_key is not null then v_src.active else p.active end,
         updated_by = v_user,
         updated_at = now()
   where p.company_id = v_company and p.branch_id = p_branch_id and p.scale_key = p_keep_key;

  -- Catálogo: los números que el que queda no tiene, del registro vinculado y leído más reciente.
  with src as (
    select distinct on (i.code) i.code, i.scale_key
    from public.scale_catalog_items i
    where i.company_id = v_company and i.branch_id = p_branch_id and i.scale_key = any (v_keys)
      and not exists (select 1 from public.scale_catalog_items k
                      where k.company_id = v_company and k.branch_id = p_branch_id and k.scale_key = p_keep_key and k.code = i.code)
    order by i.code, (i.link_kind <> 'none') desc, i.read_at desc nulls last, i.linked_at desc nulls last, i.scale_key
  )
  update public.scale_catalog_items i
     set scale_key = p_keep_key
    from src
   where i.company_id = v_company and i.branch_id = p_branch_id and i.scale_key = src.scale_key and i.code = src.code;
  get diagnostics v_items_moved = row_count;

  -- El que queda sin vínculo toma el del otro (el vinculado más reciente).
  with src as (
    select distinct on (i.code) i.code, i.link_kind, i.product_id, i.linked_by, i.linked_at
    from public.scale_catalog_items i
    where i.company_id = v_company and i.branch_id = p_branch_id and i.scale_key = any (v_keys) and i.link_kind <> 'none'
    order by i.code, i.linked_at desc nulls last, i.scale_key
  )
  update public.scale_catalog_items k
     set link_kind = src.link_kind, product_id = src.product_id, linked_by = src.linked_by, linked_at = src.linked_at
    from src
   where k.company_id = v_company and k.branch_id = p_branch_id and k.scale_key = p_keep_key and k.code = src.code and k.link_kind = 'none';
  get diagnostics v_items_linked = row_count;

  -- Lo que quedó en los registros unidos está repetido: se borra, con copia en la auditoría.
  with gone as (
    delete from public.scale_catalog_items i
    where i.company_id = v_company and i.branch_id = p_branch_id and i.scale_key = any (v_keys)
    returning i.scale_key, i.code, i.name, i.link_kind, i.product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('scale_key', scale_key, 'code', code, 'name', name, 'link_kind', link_kind, 'product_id', product_id)), '[]'::jsonb)
    into v_items_removed
  from gone;

  -- Papeles cobrados. Primero cada registro a una franja propia (no choca con nada), después se renumera la vez por
  -- orden de cobro en dos pasos (el control único se mira fila por fila).
  update public.pos_scale_paper_claims c
     set scale_key = p_keep_key,
         occurrence = c.occurrence + 1000000 * array_position(v_keys, c.scale_key)
   where c.company_id = v_company and c.branch_id = p_branch_id and c.scale_key = any (v_keys);
  get diagnostics v_claims = row_count;
  if v_claims > 0 then
    with touched as (
      select distinct ticket_date, fingerprint from public.pos_scale_paper_claims
      where company_id = v_company and branch_id = p_branch_id and scale_key = p_keep_key and occurrence > 1000000
    ),
    ranked as (
      select c.id, row_number() over (partition by c.ticket_date, c.fingerprint order by c.created_at, c.occurrence, c.id) as rn
      from public.pos_scale_paper_claims c
      join touched t on t.ticket_date = c.ticket_date and t.fingerprint = c.fingerprint
      where c.company_id = v_company and c.branch_id = p_branch_id and c.scale_key = p_keep_key
    )
    update public.pos_scale_paper_claims c set occurrence = 50000000 + r.rn from ranked r where c.id = r.id;
    update public.pos_scale_paper_claims
       set occurrence = occurrence - 50000000
     where company_id = v_company and branch_id = p_branch_id and scale_key = p_keep_key and occurrence > 50000000;
  end if;

  -- Historial de envíos (220).
  update public.scale_jobs set scale_key = p_keep_key
   where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys);
  get diagnostics v_jobs = row_count;

  -- Registros que ya se habían unido a uno de estos: ahora apuntan al que queda.
  update public.scale_profiles set merged_into = p_keep_key, updated_by = v_user, updated_at = now()
   where company_id = v_company and branch_id = p_branch_id and merged_into = any (v_keys);
  get diagnostics v_repointed = row_count;

  -- Los unidos quedan apagados y apuntando al que queda. No se borran.
  update public.scale_profiles
     set active = false, merged_into = p_keep_key, updated_by = v_user, updated_at = now()
   where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale.merge', 'scale_profile', p_keep_key,
          jsonb_build_object('keep', p_keep_key, 'merged', to_jsonb(v_keys), 'catalog_moved', v_items_moved, 'catalog_linked', v_items_linked,
                             'catalog_removed', v_items_removed, 'paper_claims', v_claims, 'jobs', v_jobs, 'repointed', v_repointed));

  return jsonb_build_object('merged', true, 'keep', p_keep_key, 'keys', to_jsonb(v_keys), 'catalog_moved', v_items_moved,
                            'catalog_linked', v_items_linked, 'catalog_removed', jsonb_array_length(v_items_removed),
                            'paper_claims', v_claims, 'jobs', v_jobs);
end;
$$;

-- ------------------------------------------------------------------------------------------------- son distintas
create or replace function public.mark_scales_distinct(p_branch_id uuid, p_keys text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_keys text[];
  v_found int;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys from unnest(coalesce(p_keys, '{}')) k where k is not null and length(btrim(k)) > 0;
  if cardinality(v_keys) < 2 then raise exception 'Elegí al menos dos balanzas'; end if;
  if cardinality(v_keys) > 20 then raise exception 'Hasta 20 balanzas por vez'; end if;
  select count(*) into v_found from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = any (v_keys);
  if v_found <> cardinality(v_keys) then raise exception 'Alguna de esas balanzas no está en la sucursal'; end if;

  update public.scale_profiles p
     set not_same_as = (select coalesce(array_agg(distinct k), '{}') from unnest(p.not_same_as || v_keys) k where k <> p.scale_key),
         updated_by = v_user,
         updated_at = now()
   where p.company_id = v_company and p.branch_id = p_branch_id and p.scale_key = any (v_keys);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale.distinct', 'scale_profile', v_keys[1], jsonb_build_object('keys', to_jsonb(v_keys)));
end;
$$;

revoke all on function public.list_duplicate_scale_candidates(uuid) from public, anon;
revoke all on function public.merge_branch_scales(uuid, text, text[]) from public, anon;
revoke all on function public.mark_scales_distinct(uuid, text[]) from public, anon;
grant execute on function public.list_duplicate_scale_candidates(uuid) to authenticated;
grant execute on function public.merge_branch_scales(uuid, text, text[]) to authenticated;
grant execute on function public.mark_scales_distinct(uuid, text[]) to authenticated;

insert into public.schema_migrations (version) values ('225_merge_branch_scales') on conflict do nothing;
