-- Mantiene al empleado Santiago (sueldo real $390.000), pero borra la actividad
-- de prueba que le cargué durante el testeo del módulo (premio, descuento, vale
-- y la liquidación de prueba que quedó cerrada con esos datos).
-- Pegar y ejecutar en el SQL Editor de Supabase.

with target_employee as (
  select id from public.employees where full_name = 'Santiago'
),
deleted_outflows as (
  delete from public.shift_outflows
  where employee_id in (select id from target_employee)
  returning treasury_movement_id
)
delete from public.treasury_movements
where id in (select treasury_movement_id from deleted_outflows where treasury_movement_id is not null);

delete from public.payroll_liquidations
where employee_id in (select id from public.employees where full_name = 'Santiago');

delete from public.payroll_adjustments
where employee_id in (select id from public.employees where full_name = 'Santiago');

-- el empleado "Santiago" NO se borra: queda activo con sueldo $390.000
