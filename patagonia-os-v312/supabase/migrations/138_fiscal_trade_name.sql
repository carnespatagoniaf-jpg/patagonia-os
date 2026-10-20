-- Nombre de fantasía en la factura (2026-10-20, pedido del dueño con la primera
-- factura real: quería que dijera solo "CARNES"). La razón social del titular
-- del CUIT es obligatoria en el comprobante, así que el nombre de fantasía va
-- arriba, grande, y la razón social sigue abajo, más chica.
-- Se guarda aparte (set_fiscal_trade_name) para no tocar save_fiscal_settings.

alter table public.company_fiscal_settings add column if not exists trade_name text;

create or replace function public.set_fiscal_trade_name(p_trade_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador cambia los datos fiscales';
  end if;
  update public.company_fiscal_settings
  set trade_name = nullif(trim(coalesce(p_trade_name, '')), ''), updated_by = v_user_id, updated_at = now()
  where company_id = v_company_id;
  if not found then
    raise exception 'Primero guardá los datos fiscales';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'fiscal.trade_name', 'company', v_company_id::text, jsonb_build_object('trade_name', p_trade_name));
end;
$$;
revoke all on function public.set_fiscal_trade_name(text) from public, anon;
grant execute on function public.set_fiscal_trade_name(text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('138_fiscal_trade_name') on conflict do nothing;
