-- 177: Caja, auditoría 29/10/2026 semana 2. No cambia ningún dato existente.
--
-- 1. Una venta ya no puede quedar dentro de un turno que se está cerrando. create_pos_sale miraba "¿el turno está
--    abierto?" sin bloquearlo: si otra caja cerraba justo en ese momento, la venta entraba igual en el turno cerrado
--    y no llegaba nunca a Tesorería (el cierre ya había sumado los cobros). Ahora la consulta toma el turno con
--    FOR SHARE: si se está cerrando, espera y, al volver a mirar, lo ve cerrado y rechaza la venta (la cola de
--    Mostrador la reintenta en el turno siguiente). Se inyecta en las definiciones vivas (104/118/167 las cambiaron).
-- 2. "Pasarla a …" (cambiar la cuenta de un cobro) solo lo hace el dueño o un administrador, y nunca a una cuenta
--    de cheques. Antes cualquier rol podía pasar un cobro en efectivo a otra cuenta y quedarse con el efectivo.

-- 1 ---------------------------------------------------------------------------------------------------------
do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_a constant text := E'and status = ''open''\n  ) then';
  v_b constant text := E'and status = ''open''\n    for share\n  ) then';
begin
  for v_proc in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'create_pos_sale'
  loop
    v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    if position('for share' in v_def) > 0 then
      raise notice '177: % ya bloquea el turno', v_proc;
    elsif position(v_a in v_def) = 0 then
      raise exception '177: % no tiene el chequeo de turno esperado (revisar a mano)', v_proc;
    else
      execute replace(v_def, v_a, v_b);
    end if;
  end loop;
end
$mig$;

-- 2 ---------------------------------------------------------------------------------------------------------
create or replace function public.change_pos_sale_payment_account(p_payment_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_sale_id uuid;
  v_old_account uuid;
  v_shift_status text;
  v_amount numeric;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador puede cambiar el medio de pago de una venta';
  end if;

  select psp.sale_id, psp.account_id, psp.amount, s.status
  into v_sale_id, v_old_account, v_amount, v_shift_status
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.pos_shifts s on s.id = ps.pos_shift_id
  where psp.id = p_payment_id and ps.company_id = v_company_id and ps.voided_at is null
  for update of psp;

  if v_sale_id is null then raise exception 'Pago inválido'; end if;
  if v_shift_status is distinct from 'open' then raise exception 'El turno de esa venta ya está cerrado'; end if;
  if not exists (
    select 1 from public.treasury_accounts
    where id = p_account_id and company_id = v_company_id and active = true and is_safe = false and cheque_role is null
  ) then
    raise exception 'Cuenta inválida';
  end if;
  if v_old_account = p_account_id then return; end if;

  update public.pos_sale_payments set account_id = p_account_id where id = p_payment_id;
  update public.pos_sales set account_id = p_account_id
  where id = v_sale_id and account_id = v_old_account
    and (select count(*) from public.pos_sale_payments where sale_id = v_sale_id) = 1;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company_id, v_user_id, 'pos_sale.change_payment_account', 'pos_sale', v_sale_id::text,
          jsonb_build_object('account_id', v_old_account, 'payment_id', p_payment_id, 'amount', v_amount),
          jsonb_build_object('account_id', p_account_id));
end;
$$;
revoke all on function public.change_pos_sale_payment_account(uuid, uuid) from public, anon;
grant execute on function public.change_pos_sale_payment_account(uuid, uuid) to authenticated;

insert into public.schema_migrations (version) values ('177_pos_shift_locks') on conflict do nothing;
