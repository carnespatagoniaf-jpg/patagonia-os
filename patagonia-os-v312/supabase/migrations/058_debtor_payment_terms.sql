-- Alertas de deudores/acreedores atrasados, pedido del dueño: cada
-- persona tiene su propio plazo acordado (uno paga cada 7 días, otro cada
-- 30), así que el plazo se carga por deudor/acreedor, no fijo para todos.
-- payment_term_days: cantidad de días que esa persona tiene para pagar
-- desde su última actividad, antes de considerarse "atrasado". Sin
-- cargar (null), no se marca como atrasado -- no hay forma de saber si
-- está tarde sin ese dato.
alter table public.creditors
  add column if not exists payment_term_days int;

alter table public.customers
  add column if not exists payment_term_days int;

-- creditor_balance/customer_balance ganan payment_term_days (para no
-- tener que pegar con la tabla base aparte) y last_activity_date: fecha
-- del último pago, o si nunca pagó nada, la deuda/entrega más vieja --
-- así el frontend (isOverdueDebt en @patagonia/domain) siempre tiene un
-- punto de partida para contar los días, sin importar si ya pagó algo o
-- todavía no.
-- Las columnas nuevas van al final: "create or replace view" no permite
-- insertar una columna en el medio del select original, solo agregar al
-- final (si no, tira "cannot change name of view column").
create or replace view public.creditor_balance as
select
  c.id as creditor_id,
  c.company_id,
  coalesce(d.total_debt, 0) as total_debt,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(d.total_debt, 0) - coalesce(p.total_paid, 0) as balance,
  c.payment_term_days,
  coalesce(p.last_payment_date, d.first_debt_date) as last_activity_date
from public.creditors c
left join (
  select creditor_id, sum(amount) as total_debt, min(debt_date) as first_debt_date
  from public.creditor_debts
  group by creditor_id
) d on d.creditor_id = c.id
left join (
  select creditor_id, sum(amount) as total_paid, max(payment_date) as last_payment_date
  from public.creditor_payments
  group by creditor_id
) p on p.creditor_id = c.id
where c.company_id = public.current_company_id();

create or replace view public.customer_balance as
select
  c.id as customer_id,
  c.company_id,
  coalesce(ch.total_charged, 0) as total_charged,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(ch.total_charged, 0) - coalesce(p.total_paid, 0) as balance,
  c.payment_term_days,
  coalesce(p.last_payment_date, ch.first_charge_date) as last_activity_date
from public.customers c
left join (
  select customer_id, sum(amount) as total_charged, min(charge_date) as first_charge_date
  from public.customer_charges
  group by customer_id
) ch on ch.customer_id = c.id
left join (
  select customer_id, sum(amount) as total_paid, max(payment_date) as last_payment_date
  from public.customer_payments
  group by customer_id
) p on p.customer_id = c.id
where c.company_id = public.current_company_id();

-- No existía forma de editar un deudor/acreedor una vez creado (mismo
-- problema que tenían proveedores) -- se agrega junto con el plazo.
create or replace function public.update_creditor(
  p_creditor_id uuid,
  p_name text,
  p_phone text default null,
  p_notes text default null,
  p_payment_term_days int default null,
  p_active boolean default true
)
returns jsonb
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_payment_term_days is not null and p_payment_term_days <= 0 then
    raise exception 'El plazo tiene que ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.creditors where id = p_creditor_id and company_id = v_company_id for update
  ) then
    raise exception 'Acreedor inválido';
  end if;

  update public.creditors
  set name = trim(p_name),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      payment_term_days = p_payment_term_days,
      active = p_active
  where id = p_creditor_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'creditor.update', 'creditor', p_creditor_id::text,
    jsonb_build_object('name', p_name, 'payment_term_days', p_payment_term_days, 'active', p_active)
  );

  return jsonb_build_object('id', p_creditor_id);
end;
$$;

revoke all on function public.update_creditor(uuid,text,text,text,int,boolean) from public;
grant execute on function public.update_creditor(uuid,text,text,text,int,boolean) to authenticated;

create or replace function public.update_customer(
  p_customer_id uuid,
  p_name text,
  p_phone text default null,
  p_notes text default null,
  p_payment_term_days int default null,
  p_active boolean default true
)
returns jsonb
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_payment_term_days is not null and p_payment_term_days <= 0 then
    raise exception 'El plazo tiene que ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id for update
  ) then
    raise exception 'Cliente inválido';
  end if;

  update public.customers
  set name = trim(p_name),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      payment_term_days = p_payment_term_days,
      active = p_active
  where id = p_customer_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'customer.update', 'customer', p_customer_id::text,
    jsonb_build_object('name', p_name, 'payment_term_days', p_payment_term_days, 'active', p_active)
  );

  return jsonb_build_object('id', p_customer_id);
end;
$$;

revoke all on function public.update_customer(uuid,text,text,text,int,boolean) from public;
grant execute on function public.update_customer(uuid,text,text,text,int,boolean) to authenticated;
