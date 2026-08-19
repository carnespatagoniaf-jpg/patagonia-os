-- El cliente dejó de usar Mercado Pago y consolidó todo el cobro con
-- tarjeta/transferencia en el posnet de Banco Provincia 2, quedando la
-- cuenta "Banco Provincia" original sin uso real. treasury_accounts.active
-- ya existía (008_treasury_and_shifts.sql) y listTreasuryAccounts() ya
-- filtra por active=true, así que solo faltaba una forma de togglearlo:
-- no había ningún RPC que tocara esa columna después de creada la cuenta.
-- No se borra nada — los movimientos históricos de esas cuentas siguen
-- intactos y visibles en Movimientos/Saldos, solo dejan de aparecer como
-- opción al cobrar, ajustar, transferir o registrar gastos.
create or replace function public.set_treasury_account_active(
  p_account_id uuid,
  p_active boolean
)
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

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta inválida';
  end if;

  update public.treasury_accounts
  set active = p_active
  where id = p_account_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'treasury_account.set_active', 'treasury_account', p_account_id::text,
    jsonb_build_object('active', p_active)
  );
end;
$$;

revoke all on function public.set_treasury_account_active(uuid, boolean) from public;
grant execute on function public.set_treasury_account_active(uuid, boolean) to authenticated;
