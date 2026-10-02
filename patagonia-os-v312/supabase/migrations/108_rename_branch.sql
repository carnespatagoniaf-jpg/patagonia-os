-- Cambiar el nombre de una sucursal (pedido del dueño, 2026-10-03: "a veces le
-- pongo 'suc 1' y está mal"). Hasta ahora solo se podía crear (create_branch).
-- Disponible en todos los planes (es un arreglo, no una función nueva) y solo
-- para dueño/administrador, igual que crear sucursales. No cambia nada más de la
-- sucursal: sus ventas, stock y cuentas siguen atadas a su id.
create or replace function public.rename_branch(
  p_branch_id uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_old_name text;
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_caller_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_caller_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para cambiar el nombre de una sucursal';
  end if;

  if length(v_name) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if length(v_name) > 60 then
    raise exception 'El nombre puede tener hasta 60 caracteres';
  end if;

  select name into v_old_name
  from public.branches
  where id = p_branch_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Sucursal inválida';
  end if;

  if exists (
    select 1 from public.branches
    where company_id = v_company_id and active = true and id <> p_branch_id and lower(name) = lower(v_name)
  ) then
    raise exception 'Ya hay otra sucursal con ese nombre';
  end if;

  update public.branches set name = v_name where id = p_branch_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company_id, p_branch_id, v_caller_id, 'branch.rename', 'branch', p_branch_id::text,
          jsonb_build_object('name', v_old_name), jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.rename_branch(uuid, text) from public, anon;
grant execute on function public.rename_branch(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('108_rename_branch') on conflict do nothing;
