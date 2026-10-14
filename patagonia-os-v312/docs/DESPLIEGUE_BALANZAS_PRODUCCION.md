# Despliegue a producción: venta con balanza (Systel) — procedimiento con respaldo, validación y reversión

**No ejecutado. Requiere la autorización del dueño.** Todo lo de abajo ya se ensayó en staging, salvo lo marcado "solo en producción".

## Antes de empezar
1. **Respaldo de la base:** producción tiene el respaldo diario de Supabase (plan Pro). Además, se anotan los conteos de control (consulta `counts.sql` de `docs/evidencia-balanzas/6-reversion-base-staging.txt`): ventas, plata no anulada, ítems, movimientos de stock, suma de stock y tesorería.
2. **Web:** se anota el id de la versión publicada hoy (Netlify; hoy `6acf9a463852339c62eabc67`). Netlify conserva cada versión lista para volver a publicarse (listado de solo lectura en la evidencia 9).
3. **Rama:** `balanzas-venta-staging`, con todas las pruebas en verde (583 automáticas + pantallas).

## Pasos
| # | Paso | Validación | Si falla |
|---|---|---|---|
| 1 | Aplicar `119_scale_sale_papers.sql` en producción. Solo crea 3 tablas y 5 funciones; no modifica nada existente | Los conteos de control son iguales a los de antes; `get_advisors` no tiene alertas nuevas; `schema_migrations` tiene la 119 | `119_scale_sale_papers.rollback.sql` (ensayada en staging: ventas, plata, stock y tesorería iguales) |
| 2 | Armar la web **sin** `VITE_SYSTEL_BARCODE_WRITES`. La versión de producción no tiene los botones de escritura (comprobado: los textos no están en el armado y la marca queda fija en "falso") | Revisar el armado (los mismos 4 textos de la evidencia 9) | No se publica |
| 3 | `scripts/deploy-netlify.mjs draft` (borrador, no público) | En la dirección del borrador: entrar, Mostrador vende normal, Stock → Balanza muestra el recuadro sin botones de escritura | No se publica |
| 4 | `deploy-netlify.mjs publish <borrador>` | Prueba rápida en producción: entrar y abrir Mostrador. Sentry sin errores nuevos | Paso R1 |
| 5 | **Ensayo de reversión (solo en producción):** `publish 6acf9a463852339c62eabc67` (la versión anterior), validar, y volver a `publish <nueva>` | Las dos versiones se abren y Mostrador vende | — |
| 6 | Cargar el catálogo de Los gringos (lectura real del 14/10) y los vínculos de los 66 que coinciden, con la función **apagada**. Encenderla recién cuando el cliente esté listo | Stock → Balanza muestra "apagada" | Apagar con el interruptor |

Las ventas de los demás clientes no pasan por nada nuevo: la venta con balanza se activa solo en una sucursal que tenga su balanza cargada **y encendida**.

## Reversión (de menor a mayor)
- **R0, interruptor** (Stock → Balanza → Apagar):
  - Mostrador vuelve a funcionar como antes en esa sucursal, al instante y sin publicar.
  - No se borra nada.
  - Las ventas guardadas sin conexión se suben igual (ensayado).
  - Queda en auditoría.
- **R1, web:** `deploy-netlify.mjs publish <id anterior>`. Es el mismo mecanismo usado hoy 4 veces.
- **R2, base:** `119_scale_sale_papers.rollback.sql`. Antes copia las 3 tablas (`bak_119_*`) y no toca ventas, stock, tesorería ni auditoría. Ensayada en staging: antes y después, 3.329 ventas, $15.147.724, 9.695 movimientos y suma de stock 104.723,027 iguales. Después se reinstaló y se repitió la prueba completa.

**Lo que ninguna reversión cambia:** las ventas cobradas siguen siendo ventas, con su stock ya descontado. Si una venta estuvo mal, se anula en Mostrador, que devuelve el stock como cualquier venta.
