# Auditoría multisucursal (Etapa 1) — 2026-10-04

Revisión de solo lectura: código de la web (`apps/web/src`) y estructura de la base de producción
(tablas, vistas, reglas de acceso y funciones; **ningún dato de clientes**). No se modificó nada.

## 1. Cómo está armado

- **Empresa → sucursales → usuarios.** Cada usuario (`profiles`) pertenece a una empresa y tiene una sucursal y un rol.
- **Quién cambia de sucursal.** El dueño y el administrador (`branches.manage`) pueden pasar a cualquier sucursal desde el selector de arriba. Encargado, cajero, producción y lectura quedan fijos en la suya (`BranchProvider.tsx`).
- **Aislamiento entre empresas.** Las reglas de acceso de la base (RLS) separan **por empresa** en las 80 tablas. Ninguna separa **por sucursal**: dentro de una empresa, la separación entre locales la hace la pantalla, no la base.
- **Productos.** El catálogo y el precio son **de la empresa** (uno solo para los 6 locales). El **stock es por sucursal**: la vista `products_with_stock` lo calcula para cada local con sus movimientos.
- **Lo que es por sucursal:** ventas de Mostrador y turnos, cierres de caja, compras, movimientos de stock, despostes, conteos de stock, períodos de rentabilidad, liquidaciones, gastos y movimientos de tesorería. Todo tiene `branch_id` obligatorio.
- **Lo que es de la empresa:** productos y precios, categorías, proveedores (y su saldo), recetas, plantillas de desposte y conciliación bancaria.
- **Cuentas de tesorería.** Por defecto **todas son compartidas** entre sucursales. Se pueden asignar a un local (`set_treasury_account_branch`, desplegable en Tesorería).
- **Consolidado.** Existe la pantalla "Sucursales" (`get_branches_overview`): stock valorizado, ventas de **hoy** y caja abierta por local, más el total. También la transferencia de stock entre sucursales.
- **Plan.** Full no tiene límite de sucursales ni de usuarios. Estándar admite 2 sucursales y Básico 1.

## 2. Qué ya funciona con varias sucursales

| Módulo | Estado |
|---|---|
| Mostrador (ventas, cierre, vales, pagos a proveedor desde caja) | Por sucursal. Las ventas sin conexión guardan la sucursal con la que se hicieron. |
| Stock, ajustes, transferencias | Por sucursal |
| Compras | Se registran en la sucursal activa |
| Desposte | Por sucursal (plantillas compartidas) |
| Inicio (dashboard) | Muestra la sucursal activa |
| Exportar | Por sucursal |
| Balanzas | Formato de código de barras por sucursal (`branch_scale_configs`). Cable y balanza se configuran por PC. |
| Usuarios | Cada usuario tiene su sucursal; los que no son dueño/admin quedan fijos |

## 3. Problemas encontrados

### Errores (dan números incorrectos)

1. **Rentabilidad resta los costos fijos de todas las sucursales.** `Profitability.tsx` suma `fixedCosts` de toda la empresa (`listFixedCosts` no filtra por sucursal) y los descuenta de las ventas del local activo. El cierre guardado (SQL) sí usa solo los del local. Con 6 locales, la ganancia en pantalla de cada uno sale mucho menor que la real y no coincide con el cierre.
2. **Las liquidaciones de sueldo van a la sucursal que está abierta en pantalla, no a la del empleado.** La lista de empleados muestra los de todos los locales, y `close_payroll_liquidation` guarda la sucursal activa sin comprobar que sea la del empleado. Si el dueño liquida a un empleado del local 3 mirando el local 1, el gasto de sueldo queda en el local 1.

### Riesgos de configuración (no son errores de cálculo, pero confunden)

3. **Cuentas de tesorería compartidas por defecto.** Si no se asignan, el "Efectivo" de los 6 locales es una sola cuenta y no se puede saber cuánta plata hay en cada caja. Para 6 locales hay que crear una cuenta de efectivo (y un posnet) por local.
4. **Clientes, acreedores, empleados y costos fijos se listan mezclados.** Se crean en la sucursal activa, pero cada pantalla muestra los de todos los locales sin decir de cuál son.
5. **Compras y pagos por proveedor, mezclados.** El historial de un proveedor muestra las compras de todos los locales sin indicar la sucursal. El saldo del proveedor es de la empresa (correcto), pero no se ve qué local compró.
6. **Tesorería: movimientos sin filtro por sucursal.** La lista de movimientos es de toda la empresa.

### Seguridad dentro de la empresa

7. **La base no separa por sucursal.** Un cajero del local A ve en pantalla solo su local, pero técnicamente (fuera de la pantalla, con la API) podría leer datos de otro local de la misma empresa. Entre empresas distintas el aislamiento sí está en la base.
8. **Ocho funciones no comprueban que la sucursal sea de la empresa:** `create_customer`, `create_creditor`, `create_fixed_cost`, `register_customer_payment`, `register_creditor_payment`, `save_carcass_batch`, `save_stock_count` y `close_payroll_liquidation`. No hay clave compuesta ni control automático que lo impida. Llamándolas a mano se podría guardar un registro propio apuntando a un local de otra empresa. El registro no se le muestra a la otra empresa, así que no es una fuga de datos. Es un dato inconsistente que hay que cerrar.

### Faltantes (no son errores)

9. **No hay informes consolidados por período.** La pantalla Sucursales muestra solo **hoy**. No hay ventas del mes por local, ni rentabilidad de toda la empresa, ni comparativo entre locales.
10. **Precio único.** El precio de cada producto es el mismo en los 6 locales. Si el cliente necesita precios distintos por local, hoy no se puede.
11. **El rol "encargado" no tiene Mostrador.** Si en cada local el encargado también cobra, hay que darle cajero o habilitarlo.
12. **Sucursal recordada en el navegador.** Si se desactiva un local que el dueño tenía elegido, el navegador lo sigue usando hasta que elija otro. Es menor.

### Limpieza (no afecta)

- Hay 27 tablas viejas con nombres en castellano (`productos`, `empleados`, `ventas_turno`…) de una versión anterior. Tienen reglas de acceso por empresa y el sistema no las usa.

## 4. Entorno de pruebas

- **Staging (patagonia-os-pruebas) está desactualizado respecto de producción.**
  - Tiene 137 funciones y producción 145, y muchas tienen otro contenido.
  - Le faltan funciones que usa Mostrador hoy, por ejemplo `create_pos_sale` con 7 parámetros (ventas sin conexión), `register_employee_vale_from_pos_shift`, `register_supplier_payment_from_pos_shift`, `register_pos_shift_transfer`, `save_branch_scale_config` y `set_mostrador_pin`.
  - No tiene empresas ni perfiles.
- Probar ahí daría errores que no existen en producción. Antes de la Etapa 2 hay que **igualar staging con producción** (solo estructura, sin datos de clientes) o decidir otro lugar de prueba.

## 5. Propuesta de correcciones (a autorizar)

| # | Corrección | Tamaño |
|---|---|---|
| 1 | Rentabilidad: sumar solo los costos fijos del local activo | Chico (web) |
| 2 | Liquidación: usar la sucursal del empleado (y validarlo en la base) | Chico (web + 1 función) |
| 8 | Validar la sucursal en las 8 funciones | Chico (1 migración) |
| 4/5/6 | Mostrar la sucursal en listados mezclados y permitir filtrar | Mediano (web) |
| 3 | Guía de puesta en marcha para 6 locales (cuentas por local) | Documento |
| 9 | Informe consolidado por período (ventas por local y total) | Mediano, **solo si el cliente lo necesita** |
| 7 | Separación por sucursal en la base para roles que no son dueño/admin | Grande; para más adelante |
