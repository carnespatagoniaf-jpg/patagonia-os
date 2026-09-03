-- Hasta ahora los permisos eran 100% por rol (rolePermissions en
-- permissions.ts): todo admin ve exactamente lo mismo que cualquier otro
-- admin. El dueño pidió poder sacarle un permiso puntual a UNA persona
-- (ej.: que la administrativa, que es "admin", no vea Rentabilidad) sin
-- crear un rol nuevo para eso. denied_permissions es una lista de
-- permisos (mismos strings que el tipo Permission del frontend, ej.
-- 'profitability.view') que se le sacan a ese perfil por más que su rol
-- los tenga -- nunca agrega permisos que el rol no daría. Se aplica en el
-- frontend (can() en permissions.ts), mismo lugar/alcance que ya decide
-- qué pantallas ve cada rol -- no es un cambio de RLS, porque lo que
-- oculta son pantallas/reportes agregados sobre datos a los que ese rol
-- ya tiene acceso en otras partes del sistema (ej.: un admin ya ve costos
-- de compra en Compras, así que Rentabilidad no expone nada nuevo a nivel
-- de base de datos).
alter table public.profiles
  add column if not exists denied_permissions text[] not null default '{}';

create or replace function public.update_staff_user(
  p_profile_id uuid,
  p_full_name text,
  p_role text,
  p_branch_id uuid,
  p_active boolean,
  p_denied_permissions text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_company_id uuid;
  v_caller_role text;
begin
  if v_caller_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_caller_company_id, v_caller_role
  from public.profiles
  where id = v_caller_id and active = true;

  if v_caller_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_caller_role not in ('owner', 'admin') then
    raise exception 'No autorizado';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_caller_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.profiles where id = p_profile_id and company_id = v_caller_company_id
  ) then
    raise exception 'Usuario inválido';
  end if;

  if p_profile_id = v_caller_id and p_active = false then
    raise exception 'No podés desactivar tu propio usuario';
  end if;

  update public.profiles
  set full_name = trim(p_full_name),
      role = p_role,
      branch_id = p_branch_id,
      active = p_active,
      denied_permissions = coalesce(p_denied_permissions, '{}')
  where id = p_profile_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_caller_company_id, p_branch_id, v_caller_id, 'user.update', 'profile', p_profile_id::text,
    jsonb_build_object('full_name', p_full_name, 'role', p_role, 'branch_id', p_branch_id, 'active', p_active, 'denied_permissions', p_denied_permissions)
  );
end;
$$;

revoke all on function public.update_staff_user(uuid,text,text,uuid,boolean,text[]) from public;
grant execute on function public.update_staff_user(uuid,text,text,uuid,boolean,text[]) to authenticated;

drop function if exists public.update_staff_user(uuid,text,text,uuid,boolean);
