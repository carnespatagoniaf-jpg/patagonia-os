-- Ahora que "admin" (no solo "owner") tiene acceso habitual a la pantalla
-- Usuarios (para que un cliente con varias sucursales pueda dar de alta sus
-- propios cajeros/encargados), reforzamos del lado del servidor lo que la
-- pantalla ya hace del lado del cliente: nunca se puede asignar el rol
-- "owner" desde acá (mismo ALLOWED_ROLES que la Edge Function
-- create-staff-user), y nadie puede tocar la ficha de un usuario "owner"
-- existente vía este RPC.
create or replace function public.update_staff_user(
  p_profile_id uuid,
  p_full_name text,
  p_role text,
  p_branch_id uuid,
  p_active boolean
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
  v_target_role text;
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

  if p_role not in ('admin', 'manager', 'cashier', 'production', 'readonly') then
    raise exception 'Rol inválido';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_caller_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  select role into v_target_role
  from public.profiles
  where id = p_profile_id and company_id = v_caller_company_id;

  if v_target_role is null then
    raise exception 'Usuario inválido';
  end if;

  if v_target_role = 'owner' then
    raise exception 'No se puede editar a un usuario dueño';
  end if;

  if p_profile_id = v_caller_id and p_active = false then
    raise exception 'No podés desactivar tu propio usuario';
  end if;

  update public.profiles
  set full_name = trim(p_full_name),
      role = p_role,
      branch_id = p_branch_id,
      active = p_active
  where id = p_profile_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_caller_company_id, p_branch_id, v_caller_id, 'user.update', 'profile', p_profile_id::text,
    jsonb_build_object('full_name', p_full_name, 'role', p_role, 'branch_id', p_branch_id, 'active', p_active)
  );
end;
$$;

revoke all on function public.update_staff_user(uuid,text,text,uuid,boolean) from public;
grant execute on function public.update_staff_user(uuid,text,text,uuid,boolean) to authenticated;
