-- Pedido real: "Ver movimientos" (ventas del turno) y "Ver movimientos de
-- caja" (ingresos/egresos/traspasos) en Mostrador ya estaban ocultos por
-- defecto para quien puede verlos, pero un clic alcanzaba para revelarlos
-- -- cualquiera que pasara por el mostrador mientras la pantalla estaba
-- abierta los podia ver. Se agrega un PIN de 4 dígitos, guardado a nivel
-- empresa, que hay que tipear para revelarlos (no es una barrera dura --
-- companies ya es legible por cualquier usuario de la empresa vía RLS,
-- es un freno para que no se vea "sin querer" al pasar, no un secreto
-- criptográfico).
alter table public.companies
  add column if not exists mostrador_pin text;

create or replace function public.set_mostrador_pin(p_pin text)
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

  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then
    raise exception 'El PIN tiene que ser de 4 dígitos';
  end if;

  update public.companies
  set mostrador_pin = p_pin
  where id = v_company_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'company.set_mostrador_pin', 'company', v_company_id::text
  );
end;
$$;

revoke all on function public.set_mostrador_pin(text) from public;
grant execute on function public.set_mostrador_pin(text) to authenticated;
