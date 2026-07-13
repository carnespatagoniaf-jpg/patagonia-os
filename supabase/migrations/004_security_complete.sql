create policy "companies_members_select"
on public.companies for select
using (id = public.current_company_id());

create policy "branches_company_isolation"
on public.branches for select
using (company_id = public.current_company_id());

create policy "profiles_self_or_company"
on public.profiles for select
using (
  id = auth.uid()
  or company_id = public.current_company_id()
);

create policy "cash_sessions_company_isolation"
on public.cash_sessions for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "sale_items_company_isolation"
on public.sale_items for select
using (
  exists (
    select 1 from public.sales s
    where s.id = sale_id and s.company_id = public.current_company_id()
  )
);

create policy "audit_company_read"
on public.audit_log for select
using (company_id = public.current_company_id());

grant select on public.products_with_stock to authenticated;
