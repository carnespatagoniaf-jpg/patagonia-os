-- 215: Vale de mercadería desde Mostrador (pedido del dueño, 27/11/2026). Es la "Fase 3" que dejó anunciada la 066.
--
-- El empleado se lleva mercadería y se le descuenta del sueldo. En Mostrador la cajera arma el ticket como siempre y
-- elige "Vale de empleado" como forma de pago:
--   * El stock baja: un inventory_movements 'vale_mercaderia' por renglón (reference_type 'employee_vale',
--     reference_id = el vale). Una presentación se pasa a su principal sola (trigger de la 111).
--   * NO entra plata a la caja ni se toca Tesorería: no es una venta, así que el cierre de caja no la espera.
--   * Queda un pos_shift_outflows type 'vale_mercaderia' (la 066 ya lo aceptaba) por el total, sin cuenta ni movimiento
--     de Tesorería: close_payroll_liquidation ya descuenta ese type (066), así que sale de la próxima liquidación.
--   * El detalle de lo que se llevó queda en pos_shift_outflow_items.
-- Precio: el mismo que cobraría Mostrador (pos_list_unit_price: lista elegida o zona del local) menos el descuento para
-- empleados de la empresa (companies.employee_discount_pct, 0 a 50, por defecto 0). El total se redondea al peso.
-- Si el empleado tiene PIN de caja (117), se pide su PIN: nadie le carga un vale a otro sin que esté.
-- Borrar el vale (delete_pos_shift_outflow, sin tocar) devuelve el stock: trigger BEFORE DELETE en pos_shift_outflows.

alter table public.companies add column if not exists employee_discount_pct numeric(5,2) not null default 0
  check (employee_discount_pct >= 0 and employee_discount_pct <= 50);

create table if not exists public.pos_shift_outflow_items (
  id uuid primary key default gen_random_uuid(),
  outflow_id uuid not null references public.pos_shift_outflows(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  product_id uuid not null references public.products(id),
  quantity numeric not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount_pct numeric(5,2) not null default 0,
  line_total numeric(14,2) not null check (line_total >= 0)
);
create index if not exists pos_shift_outflow_items_outflow on public.pos_shift_outflow_items (outflow_id);

alter table public.pos_shift_outflow_items enable row level security;
drop policy if exists pos_shift_outflow_items_company_read on public.pos_shift_outflow_items;
create policy pos_shift_outflow_items_company_read on public.pos_shift_outflow_items
  for select to authenticated using (company_id = public.current_company_id());
-- Sin políticas de escritura (175): solo la función de abajo.

drop trigger if exists zz_accountant_readonly on public.pos_shift_outflow_items;
create trigger zz_accountant_readonly before insert or update or delete on public.pos_shift_outflow_items
  for each statement execute function public.accountant_readonly_guard();

-- p_items: [{product_id, quantity, price_list_id?}]
create or replace function public.register_employee_merchandise_vale(
  p_pos_shift_id uuid,
  p_employee_id uuid,
  p_items jsonb,
  p_pin text default null,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_branch_id uuid;
  v_employee_name text;
  v_pct numeric;
  v_outflow_id uuid := gen_random_uuid();
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_price numeric;
  v_line numeric;
  v_sum numeric := 0;
  v_total numeric;
  v_lines integer := 0;
  v_names text[] := '{}';
  v_detail text;
begin
  perform public.require_plan('estandar');
  select * into v_profile from public.profiles where id = v_user_id and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;

  select branch_id into v_branch_id from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_profile.company_id and status = 'open'
  for share;
  if v_branch_id is null then raise exception 'No hay un turno de mostrador abierto'; end if;

  select full_name into v_employee_name from public.employees
  where id = p_employee_id and company_id = v_profile.company_id and active = true;
  if v_employee_name is null then raise exception 'Empleado inválido'; end if;

  -- Con PIN de caja, el vale lo confirma el empleado con su PIN.
  if exists (select 1 from public.employee_pos_pins where employee_id = p_employee_id) then
    if nullif(trim(coalesce(p_pin, '')), '') is null then
      raise exception '% tiene PIN de caja: tiene que poner su PIN para llevarse el vale', v_employee_name;
    end if;
    perform public.pos_verify_cashier(v_profile.company_id, v_branch_id, p_employee_id, p_pin);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El vale no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Máximo 100 renglones por vale'; end if;

  select employee_discount_pct into v_pct from public.companies where id = v_profile.company_id;
  v_pct := coalesce(v_pct, 0);

  insert into public.pos_shift_outflows (
    id, pos_shift_id, company_id, branch_id, outflow_date, account_id, type, amount, detail, employee_id, created_by
  ) values (
    v_outflow_id, p_pos_shift_id, v_profile.company_id, v_branch_id, current_date, null, 'vale_mercaderia', 1,
    'Vale de mercadería', p_employee_id, v_user_id
  );

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
    where id = (v_item->>'product_id')::uuid and company_id = v_profile.company_id
    for update;
    if v_product.id is null then raise exception 'Producto inválido'; end if;
    v_qty := round((v_item->>'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 or v_qty > 500 then raise exception 'Cantidad inválida para %', v_product.name; end if;
    if v_product.unit <> 'kg' and v_qty <> round(v_qty) then
      raise exception '% se cuenta por unidad: la cantidad tiene que ser entera', v_product.name;
    end if;
    v_price := public.pos_list_unit_price(v_product, v_item);
    if v_price is null or v_price <= 0 then raise exception '% no tiene precio de venta', v_product.name; end if;
    v_line := round(v_qty * v_price * (1 - v_pct / 100), 2);

    insert into public.pos_shift_outflow_items (outflow_id, company_id, product_id, quantity, unit_price, discount_pct, line_total)
    values (v_outflow_id, v_profile.company_id, v_product.id, v_qty, v_price, v_pct, v_line);

    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    values (v_profile.company_id, v_branch_id, v_product.id, 'vale_mercaderia', -v_qty, 'employee_vale', v_outflow_id,
            'Vale de mercadería · ' || v_employee_name, v_user_id);

    v_sum := v_sum + v_line;
    v_lines := v_lines + 1;
    if cardinality(v_names) < 4 then v_names := v_names || v_product.name; end if;
  end loop;

  v_total := round(v_sum);
  if v_total <= 0 then raise exception 'El vale da $0'; end if;
  v_detail := coalesce(nullif(left(trim(coalesce(p_detail, '')), 120), ''),
    'Mercadería: ' || array_to_string(v_names, ', ') || case when v_lines > 4 then ' y ' || (v_lines - 4) || ' más' else '' end);

  update public.pos_shift_outflows set amount = v_total, detail = left(v_detail, 200) where id = v_outflow_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_branch_id, v_user_id, 'pos_shift_outflow.merchandise', 'pos_shift_outflow', v_outflow_id::text,
          jsonb_build_object('employee_id', p_employee_id, 'amount', v_total, 'lines', v_lines, 'discount_pct', v_pct, 'pos_shift_id', p_pos_shift_id));

  return jsonb_build_object('id', v_outflow_id, 'amount', v_total, 'lines', v_lines, 'discount_pct', v_pct, 'employee', v_employee_name);
end;
$$;
revoke all on function public.register_employee_merchandise_vale(uuid, uuid, jsonb, text, text) from public, anon;
grant execute on function public.register_employee_merchandise_vale(uuid, uuid, jsonb, text, text) to authenticated;

-- Borrar un vale de mercadería devuelve lo que se llevó al stock (antes de que se borren sus renglones en cascada).
create or replace function public.pos_shift_outflows_return_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.type = 'vale_mercaderia' then
    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    select old.company_id, old.branch_id, i.product_id, 'vale_mercaderia_anulado', i.quantity, 'employee_vale', old.id,
           'Vale de mercadería borrado', auth.uid()
    from public.pos_shift_outflow_items i where i.outflow_id = old.id;
  end if;
  return old;
end;
$$;
revoke all on function public.pos_shift_outflows_return_stock() from public, anon, authenticated;

drop trigger if exists pos_shift_outflows_return_stock on public.pos_shift_outflows;
create trigger pos_shift_outflows_return_stock before delete on public.pos_shift_outflows
  for each row execute function public.pos_shift_outflows_return_stock();

-- Descuento para empleados (dueño o administrador).
create or replace function public.set_employee_discount(p_pct numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_pct numeric := round(coalesce(p_pct, 0), 2);
begin
  perform public.require_role(array['owner', 'admin']);
  select * into v_profile from public.profiles where id = auth.uid() and active = true;
  if v_profile.id is null then raise exception 'Perfil inválido'; end if;
  if v_pct < 0 or v_pct > 50 then raise exception 'El descuento tiene que ser de 0 a 50 %%'; end if;
  update public.companies set employee_discount_pct = v_pct where id = v_profile.company_id;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_profile.id, 'company.employee_discount', 'company', v_profile.company_id::text, jsonb_build_object('pct', v_pct));
  return v_pct;
end;
$$;
revoke all on function public.set_employee_discount(numeric) from public, anon;
grant execute on function public.set_employee_discount(numeric) to authenticated;

insert into public.schema_migrations (version) values ('215_vale_mercaderia') on conflict do nothing;
