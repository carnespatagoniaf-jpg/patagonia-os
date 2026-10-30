-- 176: Auditoría 29/10/2026, semana 2 (controles de plata y de acceso). No cambia ningún dato existente.
--
-- 1. Empresa dada de baja = sin acceso a la base. current_company_id() miraba solo profiles.active: una empresa
--    desactivada por falta de pago quedaba bloqueada en la pantalla (AuthProvider) pero seguía leyendo y
--    escribiendo por la API. Ahora también exige companies.active.
-- 2. (Despiece en 0 kg se resolvió en la pantalla: la tabla exige kilos > 0 y el costo por kilo divide por el peso.)
-- 3. Cobros y cargos de clientes: editar o borrar uno no dejaba rastro (update/delete_customer_payment,
--    update/delete_customer_charge no escriben audit_log). Ahora queda en Auditoría con el antes y el después,
--    por trigger, sin tocar esas funciones.
-- 4. Borrar un gasto (Tesorería/Gastos) o un pago a proveedor (Compras):
--    - nunca si el movimiento ya está conciliado con el banco (descuadraba el cierre: primero se deshace la
--      conciliación);
--    - un gasto o pago sacado del cajón de Mostrador solo lo borra el dueño o un administrador (desde Mostrador
--      sigue pidiendo el PIN); antes se borraba desde Tesorería/Compras sin PIN.
--    - delete_treasury_expense ahora exige dueño o administrador (la pantalla ya era solo para ellos).

-- 1 ---------------------------------------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.id = auth.uid() and p.active = true and c.active = true
$$;

-- La ficha de SU empresa la sigue viendo aunque esté dada de baja: así el ingreso lee active = false y muestra "Esta
-- empresa está desactivada" (con la política vieja, id = current_company_id(), la ficha llegaba vacía y una web
-- vieja la tomaba como activa y entraba a un sistema vacío; revisión 30/10/2026). Solo la ficha, nada más.
create or replace function public.caller_company_id_any()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid() and active = true
$$;
revoke all on function public.caller_company_id_any() from public, anon;
grant execute on function public.caller_company_id_any() to authenticated;

alter policy companies_members_select on public.companies
  using (id = (select public.caller_company_id_any()));

-- 3 ---------------------------------------------------------------------------------------------------------
create or replace function public.audit_customer_money_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text := case tg_table_name when 'customer_payments' then 'customer_payment' else 'customer_charge' end;
begin
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (
    old.company_id,
    auth.uid(),
    v_entity || '.' || lower(tg_op),
    v_entity,
    old.id::text,
    to_jsonb(old),
    case when tg_op = 'UPDATE' then to_jsonb(new) else null end
  );
  return null;
end;
$$;
revoke all on function public.audit_customer_money_change() from public, anon, authenticated;

drop trigger if exists customer_payments_audit on public.customer_payments;
create trigger customer_payments_audit
after update or delete on public.customer_payments
for each row execute function public.audit_customer_money_change();

drop trigger if exists customer_charges_audit on public.customer_charges;
create trigger customer_charges_audit
after update or delete on public.customer_charges
for each row execute function public.audit_customer_money_change();

-- 4 ---------------------------------------------------------------------------------------------------------
-- ¿Ese movimiento ya está conciliado con una línea del banco? (interno, no se expone)
create or replace function public.treasury_movement_reconciled(p_movement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bank_line_matches where movement_id = p_movement_id)
      or exists (select 1 from public.bank_statement_lines where created_movement_id = p_movement_id)
$$;
revoke all on function public.treasury_movement_reconciled(uuid) from public, anon, authenticated;

create or replace function public.delete_treasury_expense(p_movement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador puede borrar un gasto';
  end if;

  if not exists (
    select 1 from public.treasury_movements
    where id = p_movement_id and company_id = v_company_id and movement_type = 'gasto'
  ) then
    raise exception 'Gasto inválido';
  end if;

  if public.treasury_movement_reconciled(p_movement_id) then
    raise exception 'Ese gasto ya está conciliado con el banco. Primero deshacé la conciliación en Conciliación.';
  end if;

  delete from public.treasury_movements where id = p_movement_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'treasury_expense.delete', 'treasury_movement', p_movement_id::text
  );

  return jsonb_build_object('id', p_movement_id);
end;
$$;
revoke all on function public.delete_treasury_expense(uuid) from public, anon;
grant execute on function public.delete_treasury_expense(uuid) to authenticated;

create or replace function public.delete_supplier_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_movement_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select treasury_movement_id into v_movement_id
  from public.supplier_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Pago inválido';
  end if;

  if v_movement_id is not null then
    if public.treasury_movement_reconciled(v_movement_id) then
      raise exception 'Ese pago ya está conciliado con el banco. Primero deshacé la conciliación en Conciliación.';
    end if;
    if v_role not in ('owner', 'admin')
       and exists (select 1 from public.treasury_movements where id = v_movement_id and pos_shift_id is not null) then
      raise exception 'Ese pago salió del cajón de Mostrador: lo borra el dueño o un administrador (o se borra desde Mostrador con el PIN).';
    end if;
  end if;

  delete from public.supplier_payments where id = p_payment_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'supplier_payment.delete', 'supplier_payment', p_payment_id::text
  );

  return jsonb_build_object('id', p_payment_id);
end;
$$;
revoke all on function public.delete_supplier_payment(uuid) from public, anon;
grant execute on function public.delete_supplier_payment(uuid) to authenticated;

insert into public.schema_migrations (version) values ('176_audit_week2_guards') on conflict do nothing;
