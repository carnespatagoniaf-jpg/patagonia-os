-- Limpieza de datos de prueba del módulo Empleados ("Juan Pérez").
-- Pegar y ejecutar en el SQL Editor de Supabase.

with target_employee as (
  select id from public.employees where full_name = 'Juan Pérez'
),
deleted_outflows as (
  delete from public.shift_outflows
  where employee_id in (select id from target_employee)
  returning treasury_movement_id
)
delete from public.treasury_movements
where id in (select treasury_movement_id from deleted_outflows where treasury_movement_id is not null);

delete from public.payroll_liquidations
where employee_id in (select id from public.employees where full_name = 'Juan Pérez');

delete from public.payroll_adjustments
where employee_id in (select id from public.employees where full_name = 'Juan Pérez');

delete from public.employees
where full_name = 'Juan Pérez';
