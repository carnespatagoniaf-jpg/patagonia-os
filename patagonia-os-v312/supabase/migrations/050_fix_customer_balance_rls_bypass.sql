-- Mismo bug que 031_fix_view_rls_bypass.sql, reintroducido en una vista
-- nueva: "create or replace view" corre con los permisos del dueño de la
-- vista (postgres, bypassea RLS), no con los del usuario que consulta.
-- customer_balance (048_customers.sql) quedó sin su propio filtro por
-- company_id -- como está "grant select to authenticated", cualquier
-- usuario logueado de cualquier empresa podía ver los saldos de clientes
-- de TODAS las empresas al consultarla directo, no solo la propia.
create or replace view public.customer_balance as
select
  c.id as customer_id,
  c.company_id,
  coalesce(ch.total_charged, 0) as total_charged,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(ch.total_charged, 0) - coalesce(p.total_paid, 0) as balance
from public.customers c
left join (
  select customer_id, sum(amount) as total_charged
  from public.customer_charges
  group by customer_id
) ch on ch.customer_id = c.id
left join (
  select customer_id, sum(amount) as total_paid
  from public.customer_payments
  group by customer_id
) p on p.customer_id = c.id
where c.company_id = public.current_company_id();
