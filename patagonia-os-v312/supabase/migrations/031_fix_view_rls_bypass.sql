-- Bug de seguridad: las vistas creadas con "create or replace view" corren
-- con los permisos de su dueño (el rol postgres, que bypassea RLS), no con
-- los del usuario que consulta. Como ninguna de estas 4 vistas tenía un
-- filtro propio por company_id, cualquier usuario autenticado de cualquier
-- empresa veía las filas de TODAS las empresas al consultarlas
-- directamente (treasury_balance, products_with_stock, supplier_balance,
-- creditor_balance están grant select a "authenticated").
-- Fix: agregar el filtro company_id = current_company_id() adentro de cada
-- vista, así no depende de RLS pass-through ni de quién sea el dueño.

create or replace view public.treasury_balance as
select
  a.id as account_id,
  a.company_id,
  a.name,
  a.initial_balance
    + coalesce(sum(m.amount) filter (where m.direction = 'in'), 0)
    - coalesce(sum(m.amount) filter (where m.direction = 'out'), 0) as balance,
  a.initial_balance
from public.treasury_accounts a
left join public.treasury_movements m on m.account_id = a.id
where a.company_id = public.current_company_id()
group by a.id, a.company_id, a.name, a.initial_balance;

create or replace view public.products_with_stock as
select
  p.id,
  p.company_id,
  b.id as branch_id,
  p.code,
  p.name,
  p.unit,
  p.cost,
  p.price_retail,
  p.min_stock,
  p.active,
  coalesce(cs.quantity, 0) as stock
from public.products p
cross join public.branches b
left join public.current_stock cs
  on cs.company_id = p.company_id
 and cs.branch_id = b.id
 and cs.product_id = p.id
where b.company_id = p.company_id
  and b.active = true
  and p.company_id = public.current_company_id();

create or replace view public.supplier_balance as
select
  s.id as supplier_id,
  s.company_id,
  coalesce(p.total_purchases, 0) as total_purchases,
  coalesce(pay.total_payments, 0) as total_payments,
  coalesce(p.total_purchases, 0) - coalesce(pay.total_payments, 0) as balance
from public.suppliers s
left join (
  select supplier_id, sum(total) as total_purchases
  from public.purchases
  where status = 'active'
  group by supplier_id
) p on p.supplier_id = s.id
left join (
  select supplier_id, sum(amount) as total_payments
  from public.supplier_payments
  group by supplier_id
) pay on pay.supplier_id = s.id
where s.company_id = public.current_company_id();

create or replace view public.creditor_balance as
select
  c.id as creditor_id,
  c.company_id,
  coalesce(d.total_debt, 0) as total_debt,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(d.total_debt, 0) - coalesce(p.total_paid, 0) as balance
from public.creditors c
left join (
  select creditor_id, sum(amount) as total_debt
  from public.creditor_debts
  group by creditor_id
) d on d.creditor_id = c.id
left join (
  select creditor_id, sum(amount) as total_paid
  from public.creditor_payments
  group by creditor_id
) p on p.creditor_id = c.id
where c.company_id = public.current_company_id();
