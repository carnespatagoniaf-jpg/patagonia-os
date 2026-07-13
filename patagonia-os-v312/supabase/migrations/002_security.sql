alter table public.companies enable row level security;
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.cash_movements enable row level security;
alter table public.audit_log enable row level security;

create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path=public
as $$
  select company_id
  from public.profiles
  where id = auth.uid() and active = true
$$;

create policy "products_company_isolation"
on public.products for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "inventory_company_isolation"
on public.inventory_movements for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "sales_company_isolation"
on public.sales for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "cash_company_isolation"
on public.cash_movements for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());
