-- Un "Pago a proveedor" cargado desde Salidas del turno (Ventas) solo escribía en
-- treasury_movements: bajaba la caja pero nunca tocaba supplier_payments, que es
-- la tabla que arma la cuenta corriente (supplier_balance). Se corrige para que
-- cada pago a proveedor cargado desde Ventas también quede como fila real en
-- supplier_payments, sincronizada al editar/borrar (mismo patrón que treasury_movement_id).
alter table public.shift_outflows
  add column if not exists supplier_payment_id uuid references public.supplier_payments(id);

create or replace function public.save_shift_outflow(
  p_shift_outflow_id uuid,
  p_shift_id uuid,
  p_account_id uuid,
  p_type text,
  p_amount numeric,
  p_detail text,
  p_employee_id uuid default null,
  p_supplier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_branch_id uuid;
  v_shift_date date;
  v_outflow_id uuid;
  v_movement_id uuid;
  v_supplier_payment_id uuid;
  v_account_payment_method text;
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

  if p_type not in ('vale_mercaderia','vale_adelanto','pago_proveedor','gasto') then
    raise exception 'Tipo de salida inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_detail is null or length(trim(p_detail)) = 0 then
    raise exception 'El detalle es obligatorio';
  end if;

  if p_type = 'pago_proveedor' and p_supplier_id is null then
    raise exception 'Elegí un proveedor para el pago';
  end if;

  select branch_id, shift_date into v_branch_id, v_shift_date
  from public.shift_registers
  where id = p_shift_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Turno inválido';
  end if;

  select payment_method into v_account_payment_method
  from public.treasury_accounts
  where id = p_account_id and company_id = v_company_id;

  if not found then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_shift_outflow_id is not null then
    select treasury_movement_id, supplier_payment_id
    into v_movement_id, v_supplier_payment_id
    from public.shift_outflows
    where id = p_shift_outflow_id and shift_id = p_shift_id
    for update;

    if v_movement_id is null then
      raise exception 'Salida inválida';
    end if;

    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = v_shift_date
    where id = v_movement_id;

    if p_type = 'pago_proveedor' then
      if v_supplier_payment_id is not null then
        update public.supplier_payments
        set supplier_id = p_supplier_id, amount = p_amount, payment_date = v_shift_date,
            payment_method = coalesce(v_account_payment_method, payment_method), notes = p_detail
        where id = v_supplier_payment_id;
      else
        insert into public.supplier_payments (
          company_id, branch_id, supplier_id, payment_date, amount, payment_method, notes, created_by
        ) values (
          v_company_id, v_branch_id, p_supplier_id, v_shift_date, p_amount, coalesce(v_account_payment_method, 'cash'), p_detail, v_user_id
        )
        returning id into v_supplier_payment_id;
      end if;
    elsif v_supplier_payment_id is not null then
      delete from public.supplier_payments where id = v_supplier_payment_id;
      v_supplier_payment_id := null;
    end if;

    update public.shift_outflows
    set account_id = p_account_id, type = p_type, amount = p_amount, detail = trim(p_detail),
        employee_id = p_employee_id, supplier_id = p_supplier_id, supplier_payment_id = v_supplier_payment_id
    where id = p_shift_outflow_id;

    v_outflow_id := p_shift_outflow_id;
  else
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, shift_id, notes, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'out', p_amount, p_type,
      case when p_employee_id is not null then 'employee' when p_supplier_id is not null then 'supplier' else null end,
      coalesce(p_employee_id, p_supplier_id),
      v_shift_date, p_shift_id, p_detail, v_user_id
    )
    returning id into v_movement_id;

    if p_type = 'pago_proveedor' then
      insert into public.supplier_payments (
        company_id, branch_id, supplier_id, payment_date, amount, payment_method, notes, created_by
      ) values (
        v_company_id, v_branch_id, p_supplier_id, v_shift_date, p_amount, coalesce(v_account_payment_method, 'cash'), p_detail, v_user_id
      )
      returning id into v_supplier_payment_id;
    end if;

    insert into public.shift_outflows (
      shift_id, account_id, type, amount, detail, employee_id, supplier_id, treasury_movement_id, supplier_payment_id, created_by
    ) values (
      p_shift_id, p_account_id, p_type, p_amount, trim(p_detail), p_employee_id, p_supplier_id, v_movement_id, v_supplier_payment_id, v_user_id
    )
    returning id into v_outflow_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_outflow.save', 'shift_outflow', v_outflow_id::text,
    jsonb_build_object('shift_id', p_shift_id, 'type', p_type, 'amount', p_amount, 'detail', p_detail)
  );

  return jsonb_build_object('id', v_outflow_id);
end;
$$;

revoke all on function public.save_shift_outflow(uuid,uuid,uuid,text,numeric,text,uuid,uuid) from public;
grant execute on function public.save_shift_outflow(uuid,uuid,uuid,text,numeric,text,uuid,uuid) to authenticated;

create or replace function public.delete_shift_outflow(
  p_shift_outflow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
  v_supplier_payment_id uuid;
  v_shift_id uuid;
  v_branch_id uuid;
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

  select o.treasury_movement_id, o.supplier_payment_id, o.shift_id, r.branch_id
  into v_movement_id, v_supplier_payment_id, v_shift_id, v_branch_id
  from public.shift_outflows o
  join public.shift_registers r on r.id = o.shift_id
  where o.id = p_shift_outflow_id and r.company_id = v_company_id
  for update of o;

  if v_shift_id is null then
    raise exception 'Salida inválida';
  end if;

  delete from public.shift_outflows where id = p_shift_outflow_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  if v_supplier_payment_id is not null then
    delete from public.supplier_payments where id = v_supplier_payment_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_outflow.delete', 'shift_outflow', p_shift_outflow_id::text
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_shift_outflow(uuid) from public;
grant execute on function public.delete_shift_outflow(uuid) to authenticated;

-- Backfill: el pago de $50.000 a Miguel (y cualquier otro "pago a proveedor" cargado
-- desde Ventas antes de esta migración) nunca generó su fila en supplier_payments.
-- Se crea ahora, y se vincula de vuelta al shift_outflow (supplier_payment_id) para
-- que quede correcta retroactivamente y sincronizada si se edita/borra después.
do $$
declare
  v_row record;
  v_new_id uuid;
begin
  for v_row in
    select o.id as outflow_id, r.company_id, r.branch_id, o.supplier_id, r.shift_date,
           o.amount, o.detail, o.created_by, ta.payment_method
    from public.shift_outflows o
    join public.shift_registers r on r.id = o.shift_id
    left join public.treasury_accounts ta on ta.id = o.account_id
    where o.type = 'pago_proveedor'
      and o.supplier_id is not null
      and o.supplier_payment_id is null
  loop
    insert into public.supplier_payments (
      company_id, branch_id, supplier_id, payment_date, amount, payment_method, notes, created_by
    ) values (
      v_row.company_id, v_row.branch_id, v_row.supplier_id, v_row.shift_date, v_row.amount,
      coalesce(v_row.payment_method, 'cash'), v_row.detail, v_row.created_by
    )
    returning id into v_new_id;

    update public.shift_outflows set supplier_payment_id = v_new_id where id = v_row.outflow_id;
  end loop;
end $$;
