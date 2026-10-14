-- 120: Acceso de soporte técnico a las herramientas de balanza (2026-10-14).
--
-- "Mi balanza" es la única pantalla que ve el cliente. Las herramientas técnicas (diagnósticos, puertos,
-- escritura experimental, respaldos y restauraciones a mano) quedan en un panel de soporte que SOLO se ve:
--   * si la persona es administradora de la plataforma (platform_admins), o
--   * si un administrador de la plataforma abrió el acceso de soporte para esa empresa, por unas horas
--     (por ejemplo, durante una sesión de AnyDesk en la que se entra con el usuario del cliente).
-- El acceso vence solo. Abrirlo y cerrarlo queda en audit_log de la empresa.
--
-- Solo agrega: una tabla sin políticas (nadie la lee directo) y 4 funciones.

create table if not exists public.support_access_grants (
  company_id uuid primary key references public.companies(id) on delete cascade,
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reason text
);
alter table public.support_access_grants enable row level security;
-- Sin políticas a propósito: solo las funciones de abajo la tocan.

-- ¿La persona conectada puede ver las herramientas técnicas de balanza?
create or replace function public.scale_support_tools_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.am_i_platform_admin()
      or exists (
        select 1 from public.support_access_grants g
        where g.company_id = public.current_company_id() and g.expires_at > now()
      );
$$;

-- Platform admin: abre el acceso de soporte de una empresa por p_hours horas (1 a 12).
create or replace function public.grant_scale_support_access(p_company_id uuid, p_hours integer default 2, p_reason text default null)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_hours is null or p_hours < 1 or p_hours > 12 then
    raise exception 'Horas inválidas (1 a 12)';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Cliente inválido';
  end if;
  v_expires := now() + make_interval(hours => p_hours);
  insert into public.support_access_grants (company_id, granted_by, expires_at, reason)
  values (p_company_id, auth.uid(), v_expires, p_reason)
  on conflict (company_id) do update set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, reason = excluded.reason;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (p_company_id, auth.uid(), 'support.scale_access_granted', 'company', p_company_id, jsonb_build_object('expires_at', v_expires, 'hours', p_hours, 'reason', p_reason));
  return v_expires;
end;
$$;

-- Platform admin: cierra el acceso antes de que venza.
create or replace function public.revoke_scale_support_access(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  delete from public.support_access_grants where company_id = p_company_id;
  if found then
    insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
    values (p_company_id, auth.uid(), 'support.scale_access_revoked', 'company', p_company_id, '{}'::jsonb);
  end if;
end;
$$;

-- Platform admin: hasta cuándo está abierto el acceso de cada empresa (para el panel de clientes).
create or replace function public.list_scale_support_access()
returns table (company_id uuid, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return query select g.company_id, g.expires_at from public.support_access_grants g where g.expires_at > now();
end;
$$;

revoke all on function public.scale_support_tools_enabled() from public, anon;
revoke all on function public.grant_scale_support_access(uuid, integer, text) from public, anon;
revoke all on function public.revoke_scale_support_access(uuid) from public, anon;
revoke all on function public.list_scale_support_access() from public, anon;
grant execute on function public.scale_support_tools_enabled() to authenticated;
grant execute on function public.grant_scale_support_access(uuid, integer, text) to authenticated;
grant execute on function public.revoke_scale_support_access(uuid) to authenticated;
grant execute on function public.list_scale_support_access() to authenticated;

insert into public.schema_migrations (version) values ('120_scale_support_access') on conflict do nothing;
