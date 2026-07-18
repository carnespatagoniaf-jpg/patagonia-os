-- Borra TODOS los datos de negocio cargados (ventas, compras, tesorería,
-- empleados, rentabilidad, despiece, deudas, stock) para dejar el sistema
-- listo para uso real. Mantiene: companies/branches/profiles (login), las
-- cuentas de tesorería (con saldo inicial en $0) y el catálogo de productos.

delete from public.creditor_payments;
delete from public.creditor_debts;
delete from public.creditors;

delete from public.carcass_batches; -- cascada: borra carcass_cuts

delete from public.stock_counts;
delete from public.profitability_periods;
delete from public.fixed_costs;

delete from public.shift_registers; -- cascada: borra shift_sales y shift_outflows

delete from public.payroll_liquidations;
delete from public.payroll_adjustments;
delete from public.employees;

delete from public.treasury_movements;

delete from public.purchase_items;
delete from public.supplier_payments;
delete from public.purchases;
delete from public.suppliers;

delete from public.inventory_movements;
delete from public.cash_movements;
delete from public.cash_sessions;

delete from public.audit_log;

update public.treasury_accounts set initial_balance = 0;
