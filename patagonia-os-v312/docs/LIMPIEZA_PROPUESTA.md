# Limpieza propuesta (auditoría 29/10/2026). NO aplicada: necesita el OK del dueño

Revisado el 30/10/2026 en producción, solo lectura. Nada de esto se usa, pero borrar es irreversible y el pipeline
frena cualquier `drop` (PROTEGER_DATOS), así que va como migración revisada a mano con `supabase.yml`, después de
bajar una copia.

## 1. Tablas de una versión anterior del sistema (en castellano)

No figuran en ninguna migración del repo, ninguna pantalla las lee y se aíslan por `empresa_id = auth_empresa_id()`
(no por `company_id`). Tienen RLS y nadie de afuera las puede leer. Última lectura: 18/10/2026.

| Tabla | Filas | Nota |
|---|---|---|
| compras / compra_items | 5 / 5 | |
| despostes / desposte_items | 0 / 0 | |
| empleados / pagos_empleado | 3 / 0 | `pagos_empleado` mira una tabla `liquidaciones` |
| productos | 0 | |
| proveedores | 7 | |
| turnos_caja / salidas_turno / ventas_turno / ventas_turno_medios | 5 / 9 / 5 / 16 | |

Pasos propuestos:
1. Bajar las filas a un CSV (son 50 en total).
2. `drop table` de las 12, más `auth_empresa_id()` y `liquidaciones` si no la usa nada más.

## 2. Camino viejo de venta con carrito (003)

`sales`, `sale_items`, `cash_sessions` y `create_sale_transaction` tienen 0 filas y ninguna pantalla los llama. Lo
reemplazó Mostrador (`pos_sales`). El router `apps/api/src/modules/sales` solo valida y devuelve 501. Propuesta: borrar
las tres tablas, la función y el router.

## 3. Lo que NO se toca

- Turnos (`shift_*`): está oculto, pero tiene historia y se puede volver a prender.
- `Scales.tsx` (pantalla Balanzas oculta), `SystelPanel` (`SHOW_SYSTEL_PANEL = false`): están a propósito.
- Los archivos de prueba con capturas reales de balanzas (`*-real-*.ts`, `*-fake*.ts`).

En la web no quedó ningún archivo que nadie use (revisado con un script, 30/10).
