-- Plantillas de despiece: el dueño pidió no tener que cargar cada corte
-- a mano cada vez que entra una media res -- que el sistema sepa, por
-- tipo de animal, qué cortes esperar y qué % del peso total representa
-- cada uno (ej. "bola de lomo: 2.7%"), para generarlos solos al cargar
-- la res y que el carnicero solo ajuste el peso real con la balanza.
-- El % de cada plantilla suma lo que se espera VENDER -- el resto del
-- peso (hueso, grasa, merma) queda afuera a propósito: no es un corte
-- más, es información real de rendimiento que se muestra aparte en la
-- pantalla (cargado vs. peso total), nunca forzada a sumar el 100%.
create table if not exists public.carcass_cut_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  animal_type text not null,
  cut_name text not null,
  yield_percent numeric(5,2) not null check (yield_percent > 0 and yield_percent <= 100),
  product_id uuid references public.products(id),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.carcass_cut_templates enable row level security;

create policy "carcass_cut_templates_company_isolation"
on public.carcass_cut_templates for select
using (company_id = public.current_company_id());

create or replace function public.save_carcass_cut_template(
  p_template_id uuid,
  p_animal_type text,
  p_cut_name text,
  p_yield_percent numeric,
  p_product_id uuid default null,
  p_sort_order int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid;
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

  if p_animal_type is null or length(trim(p_animal_type)) = 0 then
    raise exception 'Falta el tipo de animal';
  end if;

  if p_cut_name is null or length(trim(p_cut_name)) = 0 then
    raise exception 'Falta el nombre del corte';
  end if;

  if p_yield_percent is null or p_yield_percent <= 0 or p_yield_percent > 100 then
    raise exception 'El porcentaje de rendimiento tiene que ser entre 0 y 100';
  end if;

  if p_product_id is not null and not exists (
    select 1 from public.products where id = p_product_id and company_id = v_company_id
  ) then
    raise exception 'Producto inválido';
  end if;

  if p_template_id is not null then
    if not exists (
      select 1 from public.carcass_cut_templates where id = p_template_id and company_id = v_company_id
    ) then
      raise exception 'Plantilla inválida';
    end if;

    update public.carcass_cut_templates
    set animal_type = trim(p_animal_type),
        cut_name = trim(p_cut_name),
        yield_percent = p_yield_percent,
        product_id = p_product_id,
        sort_order = p_sort_order
    where id = p_template_id;

    v_id := p_template_id;
  else
    v_id := gen_random_uuid();
    insert into public.carcass_cut_templates (
      id, company_id, animal_type, cut_name, yield_percent, product_id, sort_order
    ) values (
      v_id, v_company_id, trim(p_animal_type), trim(p_cut_name), p_yield_percent, p_product_id, p_sort_order
    );
  end if;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_carcass_cut_template(uuid,text,text,numeric,uuid,int) from public;
grant execute on function public.save_carcass_cut_template(uuid,text,text,numeric,uuid,int) to authenticated;

create or replace function public.delete_carcass_cut_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  delete from public.carcass_cut_templates where id = p_template_id and company_id = v_company_id;
end;
$$;

revoke all on function public.delete_carcass_cut_template(uuid) from public;
grant execute on function public.delete_carcass_cut_template(uuid) to authenticated;
