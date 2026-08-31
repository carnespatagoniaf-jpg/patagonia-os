-- Aviso suave (no bloqueo) para cuando una sucursal mezcla Turnos y
-- Mostrador. Cada sucursal elige, al darse de alta o después, con qué
-- método vende ('turnos' = carga manual de un total en Turnos, 'mostrador'
-- = venta ítem a ítem en Mostrador). Si no se define, sin_definir: no se
-- avisa nada (comportamiento actual, sin cambios). El campo es solo una
-- señal para la UI -- no impide cargar por el otro método, solo dispara
-- una confirmación antes de guardar.
alter table public.branches
  add column if not exists sales_mode text check (sales_mode in ('turnos', 'mostrador'));

create or replace function public.set_branch_sales_mode(
  p_branch_id uuid,
  p_sales_mode text
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

  if p_sales_mode is not null and p_sales_mode not in ('turnos', 'mostrador') then
    raise exception 'Modo de venta inválido';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_caller_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  update public.branches
  set sales_mode = p_sales_mode
  where id = p_branch_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_caller_company_id, p_branch_id, v_caller_id, 'branch.sales_mode', 'branch', p_branch_id::text,
    jsonb_build_object('sales_mode', p_sales_mode)
  );
end;
$$;

revoke all on function public.set_branch_sales_mode(uuid, text) from public;
grant execute on function public.set_branch_sales_mode(uuid, text) to authenticated;
