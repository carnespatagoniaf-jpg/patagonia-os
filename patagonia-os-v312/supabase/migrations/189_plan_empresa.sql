-- 189: Plan "Empresa", arriba de Full (2026-11-02, decisión del dueño: "todo esto lo pondría en otro plan,
-- plan empresa"). Es para cadenas (Della Finca, 7 locales): las etapas 2, 3 y 4 de Sucursales (pedidos entre
-- locales con remito y recepción, mínimos por local, encargados de varios locales, facturación por local,
-- precios por zona, compras repartidas, abrir un local copiando otro) piden este plan.
--
-- Lo que ya estaba en Full (incluido el tablero de Sucursales, etapa 1) sigue en Full: una pantalla nunca
-- sube de plan (regla del dueño, 2026-09-29). Empresa incluye todo lo de Full y no tiene límites.
-- Ninguna empresa cambia de plan acá: el dueño la pasa a Empresa desde el panel de plataforma.

alter table public.companies drop constraint if exists companies_plan_check;
alter table public.companies add constraint companies_plan_check check (plan in ('basico', 'estandar', 'full', 'empresa'));

-- Un valor desconocido sigue contando como el más alto (como en la 101).
create or replace function public.plan_rank(p_plan text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_plan when 'basico' then 1 when 'estandar' then 2 when 'full' then 3 when 'empresa' then 4 else 4 end;
$$;

create or replace function public.plan_display_name(p_plan text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_plan when 'basico' then 'Básico' when 'estandar' then 'Estándar' when 'full' then 'Full' when 'empresa' then 'Empresa' else p_plan end;
$$;

-- plan_limits no cambia: todo lo que no es basico/estandar es sin límite (Full y Empresa).

create or replace function public.set_company_plan(p_company_id uuid, p_plan text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_plan is null or p_plan not in ('basico', 'estandar', 'full', 'empresa') then
    raise exception 'Plan inválido';
  end if;

  update public.companies set plan = p_plan where id = p_company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_plan(uuid, text) from public, anon;
grant execute on function public.set_company_plan(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('189_plan_empresa') on conflict do nothing;
