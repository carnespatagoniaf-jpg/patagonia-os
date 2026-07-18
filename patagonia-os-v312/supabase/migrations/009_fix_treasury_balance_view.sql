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
group by a.id, a.company_id, a.name, a.initial_balance;
