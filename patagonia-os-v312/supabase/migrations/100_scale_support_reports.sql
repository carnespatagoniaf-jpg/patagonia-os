-- 100 - Reportes de balanzas para soporte ("Enviar a soporte").
--
-- Las balanzas se prueban en el local de cada cliente, sin nadie de
-- Patagonia OS al lado. Antes el cliente tenia que tocar "Copiar para
-- soporte" y pegar el texto por WhatsApp. Ahora, con un boton, el registro
-- de la balanza queda guardado aca y el administrador de la plataforma lo
-- ve en su pantalla, con el nombre del cliente.
--
-- Que se guarda: solo datos tecnicos de la balanza (que se detecto, pruebas,
-- errores, pesos leidos, cuantos productos se sincronizaron) + las balanzas
-- configuradas en esa PC + el navegador + una nota opcional del cliente.
-- Nada de ventas, saldos ni clientes.
--
-- Seguridad: RLS sin ninguna politica (nadie lee ni escribe la tabla
-- directo). Se escribe solo con submit_scale_support_report (dueno o
-- administrador de la empresa, con tope diario) y se lee solo con
-- list_scale_support_reports (solo administradores de plataforma).

create table if not exists public.scale_support_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  note text,
  log_text text not null,
  connections jsonb not null default '[]'::jsonb,
  user_agent text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists scale_support_reports_created_idx on public.scale_support_reports (created_at desc);
create index if not exists scale_support_reports_company_idx on public.scale_support_reports (company_id, created_at desc);

alter table public.scale_support_reports enable row level security;
revoke all on public.scale_support_reports from anon, authenticated;

create or replace function public.submit_scale_support_report(
  p_note text,
  p_log_text text,
  p_connections jsonb,
  p_user_agent text,
  p_branch_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_active boolean;
  v_branch_id uuid;
  v_today_count integer;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'No autenticado';
  end if;

  select company_id, role, active into v_company_id, v_role, v_active
  from public.profiles where id = v_user_id;

  if v_company_id is null or not coalesce(v_active, false) then
    raise exception 'Perfil inválido';
  end if;
  -- Misma gente que ve la pantalla Balanzas (permiso scales.manage).
  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado';
  end if;

  if p_log_text is null or length(trim(p_log_text)) = 0 then
    raise exception 'No hay actividad para enviar';
  end if;

  -- La sucursal es informativa: solo se guarda si es de esta empresa.
  if p_branch_id is not null then
    select id into v_branch_id from public.branches where id = p_branch_id and company_id = v_company_id;
  end if;

  -- Tope por empresa para que un boton apretado muchas veces no llene la tabla.
  select count(*) into v_today_count
  from public.scale_support_reports
  where company_id = v_company_id and created_at > now() - interval '1 day';
  if v_today_count >= 20 then
    raise exception 'Ya se mandaron muchos reportes hoy. Escribinos por WhatsApp.';
  end if;

  insert into public.scale_support_reports (company_id, branch_id, user_id, note, log_text, connections, user_agent)
  values (
    v_company_id,
    v_branch_id,
    v_user_id,
    nullif(left(trim(coalesce(p_note, '')), 1000), ''),
    left(p_log_text, 60000),
    case when jsonb_typeof(p_connections) = 'array' then p_connections else '[]'::jsonb end,
    left(p_user_agent, 400)
  )
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_branch_id, v_user_id, 'scale_support_report.submit', 'scale_support_report', v_id::text,
          jsonb_build_object('has_note', p_note is not null and length(trim(p_note)) > 0));

  return v_id;
end;
$$;

revoke all on function public.submit_scale_support_report(text, text, jsonb, text, uuid) from public;
grant execute on function public.submit_scale_support_report(text, text, jsonb, text, uuid) to authenticated;

create or replace function public.list_scale_support_reports()
returns table (
  id uuid,
  company_id uuid,
  company_name text,
  branch_name text,
  user_name text,
  note text,
  log_text text,
  connections jsonb,
  user_agent text,
  created_at timestamptz,
  resolved_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  return query
  select r.id, r.company_id, c.name, b.name, p.full_name, r.note, r.log_text, r.connections, r.user_agent, r.created_at, r.resolved_at
  from public.scale_support_reports r
  join public.companies c on c.id = r.company_id
  left join public.branches b on b.id = r.branch_id
  left join public.profiles p on p.id = r.user_id
  order by r.resolved_at is not null, r.created_at desc
  limit 100;
end;
$$;

revoke all on function public.list_scale_support_reports() from public;
grant execute on function public.list_scale_support_reports() to authenticated;

create or replace function public.set_scale_support_report_resolved(p_id uuid, p_resolved boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  update public.scale_support_reports
  set resolved_at = case when p_resolved then now() else null end
  where id = p_id;

  if not found then
    raise exception 'Reporte inválido';
  end if;
end;
$$;

revoke all on function public.set_scale_support_report_resolved(uuid, boolean) from public;
grant execute on function public.set_scale_support_report_resolved(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('100_scale_support_reports') on conflict do nothing;
