-- 162: cortes típicos "de fábrica" para Despiece (2026-10-27, pedido del dueño).
--
-- Por qué: de ~18 clientes que probaron Despiece casi todos cargaron 1 a 3 reses y no volvieron, y solo 6 armaron
-- sus "cortes de siempre" (plantilla). Sin plantilla cada res se carga corte por corte. Ahora media res, cerdo y
-- pollo vienen con los cortes y rindes típicos: la primera compra "Para despostar" de ese animal ya se reparte sola.
--
-- 1. carcass_default_cut_templates: los cortes típicos por animal (type_key). Solo lectura, iguales para todos.
-- 2. carcass_norm / carcass_type_key: nombre normalizado ("Vaca / media res", "MEDIA RES", "media res" → mediares).
--    Misma cuenta que carcass-types.ts (web).
-- 3. carcass_ensure_default_templates (interno): si la empresa no tiene cortes de siempre para ese animal, copia los
--    típicos a carcass_cut_templates con el nombre que usa la empresa, y une cada corte con el producto de Stock que
--    se llama igual (si hay uno solo). Después se editan como cualquier plantilla.
-- 4. carcass_batch_from_purchase_item (misma firma) llama a 3 antes de repartir SOLO si es la primera vez que la
--    empresa desposta ese animal (quien ya cargaba cortes a mano sigue igual), y carcass_fill_from_template
--    reconoce el animal por su clave (no por el nombre exacto).
-- 5. use_default_carcass_cuts(p_animal_type): lo mismo desde la pantalla ("Usar los cortes típicos").

create table if not exists public.carcass_default_cut_templates (
  type_key text not null,
  cut_name text not null,
  yield_percent numeric(5,2) not null check (yield_percent > 0 and yield_percent <= 100),
  sort_order int not null default 0,
  primary key (type_key, cut_name)
);

alter table public.carcass_default_cut_templates enable row level security;

drop policy if exists "carcass_default_cut_templates_read" on public.carcass_default_cut_templates;
create policy "carcass_default_cut_templates_read"
on public.carcass_default_cut_templates for select
to authenticated
using (true);

revoke insert, update, delete on public.carcass_default_cut_templates from anon, authenticated;

-- Rindes típicos en % del peso de lo que entra (media res de novillo, medio cerdo, pollo entero). El resto es
-- hueso, grasa y merma: no suman 100 a propósito, igual que las plantillas de los clientes.
insert into public.carcass_default_cut_templates (type_key, cut_name, yield_percent, sort_order) values
  ('mediares', 'Asado', 9.5, 1),
  ('mediares', 'Vacío', 3.5, 2),
  ('mediares', 'Matambre', 1.6, 3),
  ('mediares', 'Falda', 3.5, 4),
  ('mediares', 'Tapa de asado', 1.6, 5),
  ('mediares', 'Bife ancho', 4.0, 6),
  ('mediares', 'Bife angosto', 4.5, 7),
  ('mediares', 'Lomo', 1.8, 8),
  ('mediares', 'Cuadril', 2.8, 9),
  ('mediares', 'Picaña', 0.8, 10),
  ('mediares', 'Colita de cuadril', 0.9, 11),
  ('mediares', 'Nalga', 5.5, 12),
  ('mediares', 'Tapa de nalga', 1.6, 13),
  ('mediares', 'Cuadrada', 3.0, 14),
  ('mediares', 'Peceto', 1.4, 15),
  ('mediares', 'Bola de lomo', 3.2, 16),
  ('mediares', 'Tortuguita', 1.0, 17),
  ('mediares', 'Palomita', 0.7, 18),
  ('mediares', 'Paleta', 4.0, 19),
  ('mediares', 'Roast beef', 2.5, 20),
  ('mediares', 'Aguja', 3.0, 21),
  ('mediares', 'Osobuco', 3.0, 22),
  ('mediares', 'Carne picada', 8.0, 23),
  ('cerdo', 'Bondiola', 6.0, 1),
  ('cerdo', 'Carré', 12.0, 2),
  ('cerdo', 'Pechito', 9.0, 3),
  ('cerdo', 'Matambrito', 2.5, 4),
  ('cerdo', 'Solomillo', 1.5, 5),
  ('cerdo', 'Paleta', 12.0, 6),
  ('cerdo', 'Pernil', 20.0, 7),
  ('cerdo', 'Panceta', 6.0, 8),
  ('cerdo', 'Patitas', 2.5, 9),
  ('cerdo', 'Carne picada', 5.0, 10),
  ('pollo', 'Pata muslo', 33.0, 1),
  ('pollo', 'Pechuga', 32.0, 2),
  ('pollo', 'Alas', 10.0, 3),
  ('pollo', 'Menudos', 5.0, 4),
  ('pollo', 'Carcasa', 10.0, 5)
on conflict (type_key, cut_name) do update set yield_percent = excluded.yield_percent, sort_order = excluded.sort_order;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'accountant_readonly_guard' and pronamespace = 'public'::regnamespace) then
    drop trigger if exists zz_accountant_readonly on public.carcass_default_cut_templates;
    create trigger zz_accountant_readonly before insert or update or delete on public.carcass_default_cut_templates
      for each statement execute function public.accountant_readonly_guard();
  end if;
end $$;

-- Minúsculas, sin acentos, solo letras y números.
create or replace function public.carcass_norm(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(translate(lower(trim(coalesce(p_text, ''))), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]', '', 'g');
$$;

-- El animal: los nombres que significan lo mismo dan la misma clave.
create or replace function public.carcass_type_key(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when n in ('mediares', 'vacamediares', 'mediaresvaca', 'mediaresdevaca', 'mediaresnovillo', 'mediaresdenovillo', 'vaca', 'novillo', 'carne', 'carnevacuna') then 'mediares'
    when n in ('cerdo', 'cerdos', 'mediocerdo', 'mediaresdecerdo', 'mediarescerdo', 'cerdoentero', 'porcino') then 'cerdo'
    when n in ('pollo', 'pollos', 'cajondepollo', 'cajonpollo', 'cajonesdepollo', 'polloentero') then 'pollo'
    else n
  end
  from (select public.carcass_norm(p_text) as n) x;
$$;

-- Interno: copia los cortes típicos a la empresa si no tiene cortes de siempre para ese animal.
create or replace function public.carcass_ensure_default_templates(p_company_id uuid, p_animal_type text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := public.carcass_type_key(p_animal_type);
  v_count int;
begin
  if p_company_id is null or v_key = '' then
    return 0;
  end if;
  if exists (
    select 1 from public.carcass_cut_templates
    where company_id = p_company_id and public.carcass_type_key(animal_type) = v_key
  ) then
    return 0;
  end if;

  insert into public.carcass_cut_templates (company_id, animal_type, cut_name, yield_percent, product_id, sort_order)
  select p_company_id, trim(p_animal_type), d.cut_name, d.yield_percent,
         (select min(p.id::text)::uuid from public.products p
          where p.company_id = p_company_id and public.carcass_norm(p.name) = public.carcass_norm(d.cut_name)
          having count(*) = 1),
         d.sort_order
  from public.carcass_default_cut_templates d
  where d.type_key = v_key;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.carcass_ensure_default_templates(uuid, text) from public, anon, authenticated;

-- Misma función que la 126, pero reconoce el animal por su clave: "Media res novillo" en la compra usa los cortes
-- de siempre guardados como "Vaca / media res".
create or replace function public.carcass_fill_from_template(p_batch_id uuid, p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_batch public.carcass_batches%rowtype;
  v_key text;
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
  v_key := public.carcass_type_key(v_batch.animal_type);

  select coalesce(sum(yield_percent), 0) into v_sum
  from public.carcass_cut_templates
  where company_id = v_batch.company_id and public.carcass_type_key(animal_type) = v_key;
  if v_sum <= 0 or v_sum > 100 then
    return 0;
  end if;

  for t in
    select ct.cut_name, ct.yield_percent, ct.product_id, p.price_retail
    from public.carcass_cut_templates ct
    left join public.products p on p.id = ct.product_id and p.company_id = v_batch.company_id
    where ct.company_id = v_batch.company_id and public.carcass_type_key(ct.animal_type) = v_key
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
$fn$;

revoke all on function public.carcass_fill_from_template(uuid, uuid) from public, anon, authenticated;

-- Misma función que la 126, más la línea que copia los cortes típicos antes de repartir.
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

  -- Los típicos se usan solos solo la primera vez que el negocio desposta ese animal: quien ya venía cargando los
  -- cortes a mano sigue igual (no se le mueve el stock con kilos estimados); tiene el botón "Usar los cortes típicos".
  if not exists (
    select 1 from public.carcass_batches
    where company_id = v_item.company_id and id <> v_batch_id
      and public.carcass_type_key(animal_type) = public.carcass_type_key(v_item.carcass_animal_type)
  ) then
    perform public.carcass_ensure_default_templates(v_item.company_id, v_item.carcass_animal_type);
  end if;
  v_cuts := public.carcass_fill_from_template(v_batch_id, p_user_id);
  return jsonb_build_object('batch_id', v_batch_id, 'animal_type', v_item.carcass_animal_type, 'cuts', v_cuts);
end;
$$;

revoke all on function public.carcass_batch_from_purchase_item(uuid, uuid) from public, anon, authenticated;

-- Desde la pantalla: "Usar los cortes típicos".
create or replace function public.use_default_carcass_cuts(p_animal_type text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_count int;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  if v_profile.id is null then
    raise exception 'Perfil inválido';
  end if;
  if p_animal_type is null or length(trim(p_animal_type)) = 0 then
    raise exception 'Falta qué despostás';
  end if;

  v_count := public.carcass_ensure_default_templates(v_profile.company_id, p_animal_type);
  if v_count > 0 then
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v_profile.company_id, v_profile.branch_id, v_user_id, 'carcass.default_templates', 'carcass_cut_templates',
            trim(p_animal_type), jsonb_build_object('animal_type', trim(p_animal_type), 'cuts', v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function public.use_default_carcass_cuts(text) from public, anon;
grant execute on function public.use_default_carcass_cuts(text) to authenticated;

insert into public.schema_migrations (version) values ('162_carcass_default_cuts') on conflict do nothing;
