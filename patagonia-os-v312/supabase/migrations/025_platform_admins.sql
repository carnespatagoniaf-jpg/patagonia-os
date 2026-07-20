-- Habilita el modelo multi-tenant real: varios clientes (empresas) en el
-- mismo proyecto de Supabase, en vez de un proyecto por cliente. El
-- aislamiento entre empresas ya existe (RLS por company_id en todas las
-- tablas de negocio); lo que faltaba era una identidad para el vendedor
-- (vos), separada de cualquier empresa, con permiso para crear empresas
-- nuevas sin escribir SQL a mano cada vez (ver Edge Function
-- create-client).
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
-- Sin políticas: nadie con la anon/authenticated key puede leer ni escribir
-- esta tabla directamente, ni siquiera su propia fila. Solo la toca la
-- service role (Edge Function create-client) o la función de abajo.

create or replace function public.am_i_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

grant execute on function public.am_i_platform_admin() to authenticated;
