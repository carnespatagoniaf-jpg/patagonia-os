-- Permite dar de alta una sucursal nueva desde la app (antes solo se podía
-- por SQL Editor). El selector de sucursal en el menú lo usan dueño/admin
-- para elegir en qué sucursal están trabajando y para cargar la próxima.
create or replace function public.create_branch(
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  insert into public.branches (id, company_id, name)
  values (v_id, v_company_id, trim(p_name));

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_branch(text) from public;
grant execute on function public.create_branch(text) to authenticated;
