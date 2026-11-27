-- 222: perfil de etiqueta de CADA balanza e inicio propio por balanza (plan balanzas v2, etapa 2). 27/11/2026.
--
-- Por qué: Mostrador lee las etiquetas con UN formato por sucursal (branch_scale_configs) y 4 listas de clientes en el
-- código (engine/weight-barcode.ts) para los locales con más de una balanza. Cada parche nuevo era otra lista. Ahora
-- cada balanza dice, como dato, cómo imprime, y la base impide que dos balanzas activas del mismo local usen el mismo
-- inicio de etiqueta.
--
-- Qué agrega (aditiva: no cambia nada que la web de hoy use; la web nueva solo lo lee con 'balanzas_v2' encendido):
-- 1. scale_profiles.label_spec (jsonb, el perfil: inicios por tipo, cifras, valor, código de TOTAL, lo que se le
--    manda — 1070 Kretz o formato Systel; forma en apps/web/src/features/scales/label-spec.ts), label_spec_history
--    (perfiles anteriores con valid_until: las etiquetas ya impresas se siguen leyendo 7 días) y status
--    ('active' | 'inactive').
-- 2. scale_label_prefixes: (empresa, sucursal, scale_key, inicio). Índice único (sucursal, inicio) entre las activas.
--    Las funciones además rechazan inicios que se pisan ("2" con "20").
-- 3. set_scale_label_spec(sucursal, balanza, perfil): valida el perfil y los inicios contra las otras balanzas activas,
--    guarda el anterior en el historial por 7 días, reserva los inicios y anota audit_log.
-- 4. allocate_scale_prefix(sucursal, balanza): la balanza que ya tiene sus inicios (la más vieja) los conserva; la que
--    choca con otra recibe uno libre (Kretz 22-29: 2-3-7 en centavos con 1070 "PP0PP05"; Systel 23-29: el 22 es el
--    TOTAL de la Cuora) y su perfil anterior queda vigente 7 días.
-- 5. set_branch_scale_status(sucursal, balanza, estado): inactiva libera sus inicios (owner/admin).
-- 6. 'balanzas_v2' en la lista de set_company_feature (inyectado como 211/214).
--
-- Roles de 3 y 4: los mismos que hoy mandan productos a la balanza (221), SIN 'readonly' (decisión del dueño 27/11:
-- solo lectura no modifica balanzas). El contador queda afuera (y zz_accountant_readonly igual lo frena).
-- Lectura: RLS por empresa. Sin políticas de escritura (175). Vuelta atrás: 222_scale_label_spec.rollback.sql.

alter table public.scale_profiles add column if not exists label_spec jsonb;
alter table public.scale_profiles add column if not exists label_spec_history jsonb not null default '[]'::jsonb;
alter table public.scale_profiles add column if not exists status text not null default 'active';
alter table public.scale_profiles drop constraint if exists scale_profiles_status_check;
alter table public.scale_profiles add constraint scale_profiles_status_check check (status in ('active', 'inactive'));
alter table public.scale_profiles drop constraint if exists scale_profiles_label_spec_history_check;
alter table public.scale_profiles add constraint scale_profiles_label_spec_history_check check (jsonb_typeof(label_spec_history) = 'array');

-- ------------------------------------------------------------------------------------------------ validación
-- Misma regla que labelSpecProblem (label-spec.ts). null = el perfil está bien; si no, el motivo.
create or replace function public.scale_label_spec_problem(p_spec jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_k text;
  v_l jsonb;
  v_w jsonb;
  v_values constant text[] := array['weight_g', 'amount_cents', 'amount_pesos', 'units'];
begin
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then return 'no es un perfil'; end if;
  if p_spec->'v' is distinct from '1'::jsonb then return 'versión desconocida'; end if;
  if jsonb_typeof(p_spec->'prefixes') is distinct from 'object' then return 'faltan los inicios'; end if;
  foreach v_k in array array['weighed', 'unit', 'total'] loop
    if jsonb_typeof(p_spec->'prefixes'->v_k) is distinct from 'null'
       and not (jsonb_typeof(p_spec->'prefixes'->v_k) = 'string' and (p_spec->'prefixes'->>v_k) ~ '^2[0-9]?$') then
      return 'inicio ' || v_k || ' inválido';
    end if;
  end loop;
  if p_spec->'prefixes'->>'weighed' is null and p_spec->'prefixes'->>'unit' is null then return 'no tiene ningún inicio de etiqueta'; end if;
  v_l := p_spec->'layout';
  if jsonb_typeof(v_l) is distinct from 'object'
     or jsonb_typeof(v_l->'prefix') is distinct from 'number' or jsonb_typeof(v_l->'code') is distinct from 'number'
     or jsonb_typeof(v_l->'value') is distinct from 'number' or jsonb_typeof(v_l->'length') is distinct from 'number'
     or jsonb_typeof(v_l->'divisor') is distinct from 'number'
     or (v_l->>'prefix') !~ '^[0-2]$' or (v_l->>'code') !~ '^[1-6]$' or (v_l->>'value') !~ '^[1-8]$' or (v_l->>'length') !~ '^(8|9|10|11|12|13)$' then
    return 'cifras inválidas';
  end if;
  if (v_l->>'prefix')::int + (v_l->>'code')::int + (v_l->>'value')::int > (v_l->>'length')::int - 1 then return 'las cifras no entran en el largo'; end if;
  if (v_l->>'divisor') not in ('1', '10', '100', '1000') then return 'divisor inválido'; end if;
  if not ((p_spec->>'value') = any (v_values)) then return 'valor inválido'; end if;
  if p_spec ? 'weighedValue' and not ((p_spec->>'weighedValue') = any (v_values)) then return 'valor de pesables inválido'; end if;
  if p_spec ? 'unitValue' and not ((p_spec->>'unitValue') = any (v_values)) then return 'valor de unitarios inválido'; end if;
  if jsonb_typeof(p_spec->'sumCode') is distinct from 'null'
     and not (jsonb_typeof(p_spec->'sumCode') = 'number' and (p_spec->>'sumCode') ~ '^[1-9][0-9]{0,5}$') then
    return 'código de TOTAL inválido';
  end if;
  v_w := p_spec->'writer';
  if jsonb_typeof(v_w) is distinct from 'null' then
    if jsonb_typeof(v_w) is distinct from 'object' then return 'escritura inválida'; end if;
    if v_w->>'kind' = 'kretz1070' then
      if coalesce(v_w->>'code', '') !~ '^2[0-9][01]2[0-9][01][15]$' then return '1070 inválido'; end if;
    elsif v_w->>'kind' = 'systel' then
      if coalesce(v_w->>'weighed', '') !~ '^2[0-9][PCI]{10}$' or coalesce(v_w->>'unit', '') !~ '^2[0-9][PCI]{10}$' then return 'formato Systel inválido'; end if;
    else
      return 'escritura inválida';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.scale_label_spec_problem(jsonb) from public, anon, authenticated;

-- Los inicios distintos que usa un perfil.
create or replace function public.scale_label_spec_prefixes(p_spec jsonb)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(distinct p order by p), '{}')
  from unnest(array[p_spec->'prefixes'->>'weighed', p_spec->'prefixes'->>'unit', p_spec->'prefixes'->>'total']) as p
  where p is not null;
$$;
revoke all on function public.scale_label_spec_prefixes(jsonb) from public, anon, authenticated;

-- El perfil de una balanza con ese inicio (igual que specWithOwnPrefix en label-spec.ts; '20' = el de siempre).
create or replace function public.scale_label_spec_with_prefix(p_family text, p_prefix text, p_total_format text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case when p_family = 'systel' and p_prefix = '20' then
    -- La de siempre: 20 pesables, 21 unitarios; el TOTAL de la Cuora (E_S, "22…") también queda reservado.
    jsonb_build_object(
      'v', 1,
      'prefixes', jsonb_build_object('weighed', '20', 'unit', '21',
        'total', case when p_total_format ~ '^2[0-9]' and left(p_total_format, 2) not in ('20', '21') then left(p_total_format, 2) end),
      'layout', jsonb_build_object('prefix', 2, 'code', 4, 'value', 6, 'length', 13, 'divisor', 1000),
      'value', 'weight_g', 'unitValue', 'units', 'sumCode', null,
      'writer', jsonb_build_object('kind', 'systel', 'weighed', '20PPPPCCCCCC', 'unit', '21PPPPCCCCCC'),
      'origin', 'systel')
  when p_family = 'systel' then
    -- Inicio propio para pesables y unitarios (el TOTAL lo lee el papel de la Systel, no se reserva).
    jsonb_build_object(
      'v', 1,
      'prefixes', jsonb_build_object('weighed', p_prefix, 'unit', p_prefix, 'total', null),
      'layout', jsonb_build_object('prefix', 2, 'code', 4, 'value', 6, 'length', 13, 'divisor', 1000),
      'value', 'weight_g', 'unitValue', 'units', 'sumCode', null,
      'writer', jsonb_build_object('kind', 'systel', 'weighed', p_prefix || 'PPPPCCCCCC', 'unit', p_prefix || 'PPPPCCCCCC'),
      'origin', 'asignado')
  else
    jsonb_build_object(
      'v', 1,
      'prefixes', jsonb_build_object('weighed', p_prefix, 'unit', p_prefix, 'total', p_prefix),
      'layout', jsonb_build_object('prefix', 2, 'code', 3, 'value', 7, 'length', 13, 'divisor', 100),
      'value', 'amount_cents', 'sumCode', 998,
      'writer', jsonb_build_object('kind', 'kretz1070', 'code', p_prefix || '0' || p_prefix || '05'),
      'origin', 'asignado')
  end;
$$;
revoke all on function public.scale_label_spec_with_prefix(text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ inicios por balanza
create table if not exists public.scale_label_prefixes (
  company_id uuid not null,
  branch_id uuid not null,
  scale_key text not null,
  prefix text not null check (prefix ~ '^2[0-9]?$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (company_id, branch_id, scale_key, prefix),
  foreign key (company_id, branch_id, scale_key) references public.scale_profiles (company_id, branch_id, scale_key) on delete cascade
);
-- La garantía dura: dos balanzas activas de un local nunca con el mismo inicio.
create unique index if not exists scale_label_prefixes_branch_prefix_active on public.scale_label_prefixes (branch_id, prefix) where active;

alter table public.scale_label_prefixes enable row level security;
drop policy if exists scale_label_prefixes_read on public.scale_label_prefixes;
create policy scale_label_prefixes_read on public.scale_label_prefixes for select to authenticated using (company_id = public.current_company_id());
-- Sin políticas de escritura: solo las funciones de abajo.
drop trigger if exists zz_accountant_readonly on public.scale_label_prefixes;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_label_prefixes
  for each statement execute function public.accountant_readonly_guard();

-- Una balanza inactiva no reserva inicios.
create or replace function public.scale_profiles_status_prefixes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.scale_label_prefixes set active = (new.status = 'active')
  where company_id = new.company_id and branch_id = new.branch_id and scale_key = new.scale_key;
  return new;
end;
$$;
revoke all on function public.scale_profiles_status_prefixes() from public, anon, authenticated;
drop trigger if exists scale_profiles_status_prefixes on public.scale_profiles;
create trigger scale_profiles_status_prefixes after update of status on public.scale_profiles
  for each row when (old.status is distinct from new.status) execute function public.scale_profiles_status_prefixes();

-- ------------------------------------------------------------------------------------------------ escritura (interna)
-- Guarda el perfil de una balanza: el anterior al historial (7 días), los inicios reservados, auditoría.
-- Quien llama ya validó empresa, sucursal, rol y el perfil, y tiene tomadas las filas de la sucursal.
create or replace function public.scale_label_apply(p_company uuid, p_branch uuid, p_key text, p_spec jsonb, p_user uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_hist jsonb;
  v_prefix text;
  v_clash record;
begin
  select label_spec, label_spec_history into v_old, v_hist
  from public.scale_profiles where company_id = p_company and branch_id = p_branch and scale_key = p_key;

  -- Inicios: ninguno se puede pisar con el de otra balanza activa del local.
  select r.scale_key, r.prefix, coalesce(sp.name, r.scale_key) as name into v_clash
  from public.scale_label_prefixes r
  join public.scale_profiles sp on sp.company_id = r.company_id and sp.branch_id = r.branch_id and sp.scale_key = r.scale_key
  where r.company_id = p_company and r.branch_id = p_branch and r.scale_key <> p_key and r.active
    and exists (select 1 from unnest(public.scale_label_spec_prefixes(p_spec)) n where n like r.prefix || '%' or r.prefix like n || '%')
  limit 1;
  if found then
    raise exception 'El inicio de etiqueta % ya lo usa la balanza "%" de este local', v_clash.prefix, v_clash.name;
  end if;

  -- Historial: solo los que siguen vigentes + el que se reemplaza (si cambió).
  v_hist := coalesce((
    select jsonb_agg(h) from jsonb_array_elements(coalesce(v_hist, '[]'::jsonb)) h
    where (h->>'valid_until')::timestamptz > now()
  ), '[]'::jsonb);
  if v_old is not null and v_old is distinct from p_spec then
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('spec', v_old, 'valid_until', now() + interval '7 days', 'replaced_at', now()));
  end if;

  update public.scale_profiles set label_spec = p_spec, label_spec_history = v_hist, updated_by = p_user, updated_at = now()
  where company_id = p_company and branch_id = p_branch and scale_key = p_key;

  delete from public.scale_label_prefixes where company_id = p_company and branch_id = p_branch and scale_key = p_key;
  foreach v_prefix in array public.scale_label_spec_prefixes(p_spec) loop
    insert into public.scale_label_prefixes (company_id, branch_id, scale_key, prefix, active)
    select p_company, p_branch, p_key, v_prefix, sp.status = 'active'
    from public.scale_profiles sp where sp.company_id = p_company and sp.branch_id = p_branch and sp.scale_key = p_key;
  end loop;

  if v_old is distinct from p_spec then
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (p_company, p_branch, p_user, p_action, 'scale_profile', p_key, jsonb_build_object('label_spec', v_old), jsonb_build_object('label_spec', p_spec));
  end if;
  return p_spec;
end;
$$;
revoke all on function public.scale_label_apply(uuid, uuid, text, jsonb, uuid, text) from public, anon, authenticated;

-- Quién llama: perfil activo, rol que manda productos (sin solo lectura), sucursal de la empresa y a su alcance.
create or replace function public.scale_label_caller(p_branch_id uuid, p_scale_key text, out company_id uuid, out user_id uuid, out family text, out total_format text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier']::text[]);
  user_id := auth.uid();
  select p.company_id into company_id from public.profiles p where p.id = user_id and p.active = true;
  if company_id is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = scale_label_caller.company_id and b.active = true) then
    raise exception 'Sucursal inválida';
  end if;
  if not public.my_branch_allowed(p_branch_id) then raise exception 'No tenés acceso a esa sucursal'; end if;
  -- Todas las balanzas del local en orden: dos cajas asignando a la vez esperan una a la otra.
  perform 1 from public.scale_profiles sp where sp.company_id = scale_label_caller.company_id and sp.branch_id = p_branch_id order by sp.scale_key for update;
  select sp.family, sp.total_format, sp.status into family, total_format, v_status
  from public.scale_profiles sp where sp.company_id = scale_label_caller.company_id and sp.branch_id = p_branch_id and sp.scale_key = p_scale_key;
  if family is null then raise exception 'La balanza no está en esa sucursal'; end if;
  if v_status <> 'active' then raise exception 'La balanza está desactivada'; end if;
end;
$$;
revoke all on function public.scale_label_caller(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ RPC
create or replace function public.set_scale_label_spec(p_branch_id uuid, p_scale_key text, p_spec jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_problem text;
  v_kind text;
begin
  select * into c from public.scale_label_caller(p_branch_id, p_scale_key);
  v_problem := public.scale_label_spec_problem(p_spec);
  if v_problem is not null then raise exception 'Perfil de etiqueta inválido: %', v_problem; end if;
  v_kind := case when c.family = 'systel' then 'systel' else 'kretz1070' end;
  if (p_spec->'writer'->>'kind') is not null and (p_spec->'writer'->>'kind') <> v_kind then
    raise exception 'Perfil de etiqueta inválido: no es de una balanza %', c.family;
  end if;
  return public.scale_label_apply(c.company_id, p_branch_id, p_scale_key, p_spec, c.user_id, 'scale.label_spec');
end;
$$;
revoke all on function public.set_scale_label_spec(uuid, text, jsonb) from public, anon;
grant execute on function public.set_scale_label_spec(uuid, text, jsonb) to authenticated;

-- Devuelve {prefix, changed, spec}. changed = true: la balanza recibió un inicio nuevo (hay que mandárselo).
create or replace function public.allocate_scale_prefix(p_branch_id uuid, p_scale_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_spec jsonb;
  v_taken text[];
  v_mine text[];
  v_candidates text[];
  v_prefix text;
  v_new jsonb;
begin
  select * into c from public.scale_label_caller(p_branch_id, p_scale_key);
  select label_spec into v_spec from public.scale_profiles where company_id = c.company_id and branch_id = p_branch_id and scale_key = p_scale_key;
  select coalesce(array_agg(r.prefix), '{}') into v_taken from public.scale_label_prefixes r
  where r.company_id = c.company_id and r.branch_id = p_branch_id and r.scale_key <> p_scale_key and r.active;

  -- Ya tiene perfil y sus inicios no chocan con los de nadie: se los queda (la más vieja conserva el suyo).
  if v_spec is not null and public.scale_label_spec_problem(v_spec) is null then
    v_mine := public.scale_label_spec_prefixes(v_spec);
    if not exists (select 1 from unnest(v_mine) m, unnest(v_taken) t where m like t || '%' or t like m || '%') then
      perform public.scale_label_apply(c.company_id, p_branch_id, p_scale_key, v_spec, c.user_id, 'scale.label_spec');
      return jsonb_build_object('prefix', coalesce(v_spec->'prefixes'->>'weighed', v_spec->'prefixes'->>'unit'), 'changed', false, 'spec', v_spec);
    end if;
  end if;

  -- Sin perfil y sin otras balanzas con inicio: el de siempre (Kretz 20, Systel 20/21).
  v_candidates := case when c.family = 'systel' then array['20', '23', '24', '25', '26', '27', '28', '29']
                       else array['20', '22', '23', '24', '25', '26', '27', '28', '29'] end;
  if v_spec is not null then v_candidates := v_candidates[2:]; end if;
  foreach v_prefix in array v_candidates loop
    v_new := public.scale_label_spec_with_prefix(c.family, v_prefix, c.total_format);
    if not exists (select 1 from unnest(public.scale_label_spec_prefixes(v_new)) m, unnest(v_taken) t where m like t || '%' or t like m || '%') then
      perform public.scale_label_apply(c.company_id, p_branch_id, p_scale_key, v_new, c.user_id, 'scale.prefix_allocate');
      return jsonb_build_object('prefix', v_prefix, 'changed', v_spec is distinct from v_new, 'spec', v_new);
    end if;
  end loop;
  raise exception 'No queda ningún inicio de etiqueta libre en este local. Avisale a soporte de Patagonia.';
end;
$$;
revoke all on function public.allocate_scale_prefix(uuid, text) from public, anon;
grant execute on function public.allocate_scale_prefix(uuid, text) to authenticated;

create or replace function public.set_branch_scale_status(p_branch_id uuid, p_scale_key text, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_old text;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if p_status is null or p_status not in ('active', 'inactive') then raise exception 'Estado inválido'; end if;
  select status into v_old from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key for update;
  if v_old is null then raise exception 'La balanza no está en esa sucursal'; end if;
  if v_old = p_status then return; end if;
  -- Reactivar: sus inicios no pueden chocar con los de otra activa.
  if p_status = 'active' and exists (
    select 1 from public.scale_label_prefixes mine join public.scale_label_prefixes other
      on other.company_id = mine.company_id and other.branch_id = mine.branch_id and other.scale_key <> mine.scale_key and other.active
     and (other.prefix like mine.prefix || '%' or mine.prefix like other.prefix || '%')
    where mine.company_id = v_company and mine.branch_id = p_branch_id and mine.scale_key = p_scale_key
  ) then
    raise exception 'Otra balanza activa de este local usa el mismo inicio de etiqueta';
  end if;
  update public.scale_profiles set status = p_status, updated_by = v_user, updated_at = now()
  where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company, p_branch_id, v_user, 'scale.status', 'scale_profile', p_scale_key, jsonb_build_object('status', v_old), jsonb_build_object('status', p_status));
end;
$$;
revoke all on function public.set_branch_scale_status(uuid, text, text) from public, anon;
grant execute on function public.set_branch_scale_status(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------------------------------------ interruptor
-- 'balanzas_v2' en la lista de set_company_feature, inyectado en la definición viva (como 211/214): la lista termina
-- en 'pedidos_tienda', 'etiquetas_caja', 'precios_excel' o 'freezer' según la base.
do $mig$
declare
  v_def text := pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure);
begin
  if position('''balanzas_v2''' in v_def) > 0 then return; end if;
  if v_def !~ '''pedidos_tienda''(, ''etiquetas_caja'')?(, ''precios_excel'')?(, ''freezer'')?\)' then
    raise exception 'set_company_feature no tiene la lista esperada';
  end if;
  execute regexp_replace(v_def, '(''pedidos_tienda''(, ''etiquetas_caja'')?(, ''precios_excel'')?(, ''freezer'')?)\)', '\1, ''balanzas_v2'')');
end
$mig$;

insert into public.schema_migrations (version) values ('222_scale_label_spec') on conflict do nothing;
