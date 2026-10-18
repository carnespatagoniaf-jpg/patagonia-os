-- VUELTA ATRÁS de 131_performance_indexes_rls.sql (generado de producción el 2026-10-18,
-- ANTES de aplicarla). Deja las policies y vistas exactamente como estaban y borra
-- los índices nuevos. Solo correr si la 131 trajo un problema.

alter policy audit_company_read on public.audit_log using ((company_id = current_company_id()));
alter policy reconciliation_read on public.bank_line_matches using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy reconciliation_read on public.bank_reconciliation_accounts using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy reconciliation_read on public.bank_reconciliation_closes using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy reconciliation_read on public.bank_reconciliation_rules using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy reconciliation_read on public.bank_statement_imports using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy reconciliation_read on public.bank_statement_lines using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy branch_scale_configs_company_isolation on public.branch_scale_configs using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy branches_company_isolation on public.branches using ((company_id = current_company_id()));
alter policy carcass_batches_company_isolation on public.carcass_batches using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy carcass_cut_templates_company_isolation on public.carcass_cut_templates using ((company_id = current_company_id()));
alter policy carcass_cuts_company_isolation on public.carcass_cuts using ((EXISTS ( SELECT 1
   FROM carcass_batches b
  WHERE ((b.id = carcass_cuts.batch_id) AND (b.company_id = current_company_id()))))) with check ((EXISTS ( SELECT 1
   FROM carcass_batches b
  WHERE ((b.id = carcass_cuts.batch_id) AND (b.company_id = current_company_id())))));
alter policy cash_company_isolation on public.cash_movements using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy cash_sessions_company_isolation on public.cash_sessions using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy companies_members_select on public.companies using ((id = current_company_id()));
alter policy fiscal_settings_company_read on public.company_fiscal_settings using ((company_id = current_company_id()));
alter policy creditor_debts_company_isolation on public.creditor_debts using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy creditor_payments_company_isolation on public.creditor_payments using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy creditors_company_isolation on public.creditors using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy customer_charge_items_company_isolation on public.customer_charge_items using ((EXISTS ( SELECT 1
   FROM customer_charges cc
  WHERE ((cc.id = customer_charge_items.charge_id) AND (cc.company_id = current_company_id()))))) with check ((EXISTS ( SELECT 1
   FROM customer_charges cc
  WHERE ((cc.id = customer_charge_items.charge_id) AND (cc.company_id = current_company_id())))));
alter policy customer_charges_company_isolation on public.customer_charges using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy customer_payments_company_isolation on public.customer_payments using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy customers_company_isolation on public.customers using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy employees_company_isolation on public.employees using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy fixed_costs_company_isolation on public.fixed_costs using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy inventory_company_isolation on public.inventory_movements using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy invoices_company_read on public.invoices using ((company_id = current_company_id()));
alter policy payroll_adjustments_company_isolation on public.payroll_adjustments using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy payroll_liquidation_payments_company_isolation on public.payroll_liquidation_payments using ((EXISTS ( SELECT 1
   FROM payroll_liquidations pl
  WHERE ((pl.id = payroll_liquidation_payments.liquidation_id) AND (pl.company_id = current_company_id())))));
alter policy payroll_liquidations_company_read on public.payroll_liquidations using ((company_id = current_company_id()));
alter policy pos_safe_deposits_read on public.pos_safe_deposits using ((company_id = current_company_id()));
alter policy pos_sale_items_company_isolation on public.pos_sale_items using ((EXISTS ( SELECT 1
   FROM pos_sales s
  WHERE ((s.id = pos_sale_items.sale_id) AND (s.company_id = current_company_id())))));
alter policy pos_sale_payments_company_isolation on public.pos_sale_payments using ((EXISTS ( SELECT 1
   FROM pos_sales s
  WHERE ((s.id = pos_sale_payments.sale_id) AND (s.company_id = current_company_id())))));
alter policy pos_sales_company_isolation on public.pos_sales using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy pos_scale_paper_claims_read on public.pos_scale_paper_claims using ((company_id = current_company_id()));
alter policy pos_shift_count_checks_read on public.pos_shift_count_checks using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy pos_shift_outflows_company_isolation on public.pos_shift_outflows using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy pos_shift_scale_controls_read on public.pos_shift_scale_controls using ((company_id = current_company_id()));
alter policy pos_shifts_company_isolation on public.pos_shifts using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy product_categories_company_isolation on public.product_categories using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy products_company_isolation on public.products using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy profiles_self_or_company on public.profiles using (((id = auth.uid()) OR (company_id = current_company_id())));
alter policy profitability_periods_company_read on public.profitability_periods using ((company_id = current_company_id()));
alter policy purchase_items_company_isolation on public.purchase_items using ((EXISTS ( SELECT 1
   FROM purchases p
  WHERE ((p.id = purchase_items.purchase_id) AND (p.company_id = current_company_id()))))) with check ((EXISTS ( SELECT 1
   FROM purchases p
  WHERE ((p.id = purchase_items.purchase_id) AND (p.company_id = current_company_id())))));
alter policy purchases_company_isolation on public.purchases using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy recipe_items_admin_read on public.recipe_items using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy recipes_admin_read on public.recipes using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND p.active AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy safe_counts_read on public.safe_counts using (((company_id = current_company_id()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));
alter policy sale_items_company_isolation on public.sale_items using ((EXISTS ( SELECT 1
   FROM sales s
  WHERE ((s.id = sale_items.sale_id) AND (s.company_id = current_company_id())))));
alter policy sales_company_isolation on public.sales using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy scale_catalog_items_read on public.scale_catalog_items using ((company_id = current_company_id()));
alter policy scale_profiles_read on public.scale_profiles using ((company_id = current_company_id()));
alter policy scale_ticket_voids_read on public.scale_ticket_voids using ((company_id = current_company_id()));
alter policy shift_outflows_company_isolation on public.shift_outflows using ((EXISTS ( SELECT 1
   FROM shift_registers r
  WHERE ((r.id = shift_outflows.shift_id) AND (r.company_id = current_company_id()))))) with check ((EXISTS ( SELECT 1
   FROM shift_registers r
  WHERE ((r.id = shift_outflows.shift_id) AND (r.company_id = current_company_id())))));
alter policy shift_registers_company_isolation on public.shift_registers using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy shift_sales_company_isolation on public.shift_sales using ((EXISTS ( SELECT 1
   FROM shift_registers r
  WHERE ((r.id = shift_sales.shift_id) AND (r.company_id = current_company_id()))))) with check ((EXISTS ( SELECT 1
   FROM shift_registers r
  WHERE ((r.id = shift_sales.shift_id) AND (r.company_id = current_company_id())))));
alter policy stock_counts_company_isolation on public.stock_counts using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy supplier_payments_company_isolation on public.supplier_payments using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy suppliers_company_isolation on public.suppliers using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy treasury_accounts_company_isolation on public.treasury_accounts using ((company_id = current_company_id())) with check ((company_id = current_company_id()));
alter policy treasury_movements_company_isolation on public.treasury_movements using ((company_id = current_company_id())) with check ((company_id = current_company_id()));

create or replace view public.current_stock as  SELECT company_id,
    branch_id,
    product_id,
    sum(quantity) AS quantity
   FROM inventory_movements
  WHERE (company_id = current_company_id())
  GROUP BY company_id, branch_id, product_id;

create or replace view public.products_with_stock as  SELECT p.id,
    p.company_id,
    b.id AS branch_id,
    p.code,
    p.name,
    p.unit,
    (
        CASE
            WHEN (( SELECT profiles.role
               FROM profiles
              WHERE (profiles.id = auth.uid())) = 'cashier'::text) THEN NULL::numeric
            ELSE p.cost
        END)::numeric(14,2) AS cost,
    p.price_retail,
    p.min_stock,
    p.active,
        CASE
            WHEN (p.stock_source_id IS NULL) THEN COALESCE(cs.quantity, (0)::numeric)
            ELSE round((COALESCE(css.quantity, (0)::numeric) / p.stock_factor), 3)
        END AS stock,
    p.category_id,
    p.stock_source_id,
    p.stock_factor
   FROM (((products p
     CROSS JOIN branches b)
     LEFT JOIN current_stock cs ON (((cs.company_id = p.company_id) AND (cs.branch_id = b.id) AND (cs.product_id = p.id))))
     LEFT JOIN current_stock css ON (((css.company_id = p.company_id) AND (css.branch_id = b.id) AND (css.product_id = p.stock_source_id))))
  WHERE ((b.company_id = p.company_id) AND (b.active = true) AND (p.company_id = current_company_id()));

create or replace view public.supplier_balance as  SELECT s.id AS supplier_id,
    s.company_id,
    COALESCE(p.total_purchases, (0)::numeric) AS total_purchases,
    COALESCE(pay.total_payments, (0)::numeric) AS total_payments,
    (COALESCE(p.total_purchases, (0)::numeric) - COALESCE(pay.total_payments, (0)::numeric)) AS balance
   FROM ((suppliers s
     LEFT JOIN ( SELECT purchases.supplier_id,
            sum(purchases.total) AS total_purchases
           FROM purchases
          WHERE (purchases.status = 'active'::text)
          GROUP BY purchases.supplier_id) p ON ((p.supplier_id = s.id)))
     LEFT JOIN ( SELECT supplier_payments.supplier_id,
            sum(supplier_payments.amount) AS total_payments
           FROM supplier_payments
          GROUP BY supplier_payments.supplier_id) pay ON ((pay.supplier_id = s.id)))
  WHERE (s.company_id = current_company_id());

create or replace view public.treasury_balance as  SELECT a.id AS account_id,
    a.company_id,
    a.name,
    ((a.initial_balance + COALESCE(sum(m.amount) FILTER (WHERE (m.direction = 'in'::text)), (0)::numeric)) - COALESCE(sum(m.amount) FILTER (WHERE (m.direction = 'out'::text)), (0)::numeric)) AS balance,
    a.initial_balance
   FROM (treasury_accounts a
     LEFT JOIN treasury_movements m ON ((m.account_id = a.id)))
  WHERE (a.company_id = current_company_id())
  GROUP BY a.id, a.company_id, a.name, a.initial_balance;

create or replace view public.creditor_balance as  SELECT c.id AS creditor_id,
    c.company_id,
    COALESCE(d.total_debt, (0)::numeric) AS total_debt,
    COALESCE(p.total_paid, (0)::numeric) AS total_paid,
    (COALESCE(d.total_debt, (0)::numeric) - COALESCE(p.total_paid, (0)::numeric)) AS balance,
    c.payment_term_days,
    COALESCE(p.last_payment_date, d.first_debt_date) AS last_activity_date
   FROM ((creditors c
     LEFT JOIN ( SELECT creditor_debts.creditor_id,
            sum(creditor_debts.amount) AS total_debt,
            min(creditor_debts.debt_date) AS first_debt_date
           FROM creditor_debts
          GROUP BY creditor_debts.creditor_id) d ON ((d.creditor_id = c.id)))
     LEFT JOIN ( SELECT creditor_payments.creditor_id,
            sum(creditor_payments.amount) AS total_paid,
            max(creditor_payments.payment_date) AS last_payment_date
           FROM creditor_payments
          GROUP BY creditor_payments.creditor_id) p ON ((p.creditor_id = c.id)))
  WHERE (c.company_id = current_company_id());

create or replace view public.customer_balance as  SELECT c.id AS customer_id,
    c.company_id,
    COALESCE(ch.total_charged, (0)::numeric) AS total_charged,
    COALESCE(p.total_paid, (0)::numeric) AS total_paid,
    (COALESCE(ch.total_charged, (0)::numeric) - COALESCE(p.total_paid, (0)::numeric)) AS balance,
    c.payment_term_days,
    COALESCE(p.last_payment_date, ch.first_charge_date) AS last_activity_date
   FROM ((customers c
     LEFT JOIN ( SELECT customer_charges.customer_id,
            sum(customer_charges.amount) AS total_charged,
            min(customer_charges.charge_date) AS first_charge_date
           FROM customer_charges
          GROUP BY customer_charges.customer_id) ch ON ((ch.customer_id = c.id)))
     LEFT JOIN ( SELECT customer_payments.customer_id,
            sum(customer_payments.amount) AS total_paid,
            max(customer_payments.payment_date) AS last_payment_date
           FROM customer_payments
          GROUP BY customer_payments.customer_id) p ON ((p.customer_id = c.id)))
  WHERE (c.company_id = current_company_id());

create or replace view public.products_price_list as  SELECT id,
    company_id,
    code,
    name,
    unit,
    price_retail,
    active
   FROM products
  WHERE (company_id = current_company_id());

do $$ declare r record; begin
  for r in select indexname from pg_indexes where schemaname = 'public' and indexname like '%_fk_idx' loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;
drop index if exists public.inventory_movements_company_branch_product_idx;
drop index if exists public.treasury_movements_company_date_idx;
drop index if exists public.pos_sales_company_branch_created_idx;
drop index if exists public.audit_log_company_created_idx;

delete from public.schema_migrations where version = '131_performance_indexes_rls';
