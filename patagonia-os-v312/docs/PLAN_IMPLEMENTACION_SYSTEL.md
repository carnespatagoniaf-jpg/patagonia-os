# Plan de implementación: Systel Cuora Max (Los gringos y próximos clientes Systel)

15/10/2026. **Nada de esto está publicado ni se escribió en ninguna balanza.**

**Objetivo:**
1. El carnicero pesa e imprime el ticket.
2. El cajero escanea cada producto y después el TOTAL, y cobra.
3. Patagonia descuenta el stock correcto.

## 1. Protocolo: qué está resuelto y qué decide la balanza real

| Duda | Estado | Evidencia |
|---|---|---|
| ¿La escritura (61) lleva byte de control? | **Sí, casi seguro** | El programa de ejemplo OFICIAL de Systel (`Prueba Protocolo Cuora W7 - VB`, `Form1.vb`) arma TODAS las órdenes, incluida la de escribir un producto (función 4), con el byte de control al final. El texto de la 61 solo lo omite. |
| ¿El tipo de código va como byte o como dígito? | **Lo decide la etapa 1**, sin riesgo | El texto dice "1 número"; la balanza lo devuelve como byte 0x01. La etapa 1 prueba las dos formas en un número de producto libre. Si rechaza una (E5/E8), no guarda nada. |
| ¿Reescribir un producto pone en cero sus totales de venta en la balanza? | **No se puede leer en la Cuora Max** (la lectura de totales existe solo en la Cuora 2) | Por eso la etapa 2 es sobre un producto sin ventas en la semana (6, TROZADITO x5). El resto se hace con el local cerrado, idealmente después del "cierre de ventas" que haga el cliente en la balanza. |
| ¿Cambia el historial de tickets? | Se comprueba en cada etapa | Huella del reporte de ventas (función 72, 40 días) antes y después: tiene que ser la misma. |
| ¿Cambia algún otro dato del producto? | Se comprueba en cada producto | Relectura byte a byte: solo pueden cambiar el código propio, el tipo y la marca "gestionado por PC". Si cambia otra cosa, se restaura y se frena. |

**Herramienta (preparada, bloqueada):** `systel-barcode-write-test.ts`.
- **Etapa 1:** número libre (7999 hacia abajo; solo si la balanza contesta "no existe"), producto "PRUEBA PATAGONIA" sin precio.
- **Etapa 2:** 1 producto real.
- **Lote de los 87:** `rewriteAllProductBarcodes`, que hace un respaldo de todos y frena en el primero que no quede confirmado.
- **Probada contra la balanza simulada con registros reales:** 19 pruebas, entre ellas la balanza que acepta byte, la que acepta dígito, un número ocupado, la escritura bloqueada, el reporte ilegible y un producto alterado y restaurado.
- **Solo usa** lectura (23, 62, 72) y la escritura 61. Nunca borra, nunca hace "cierre de ventas" y nunca cambia la configuración general.

## 2. Catálogo y stock (sin tocar datos comerciales a ciegas)

**Diferencias** (catálogo real de producción vs balanza):

| Caso | Qué se hace | Quién decide |
|---|---|---|
| 66 productos iguales | "Vincular los que coinciden" (1 clic) | Dueño |
| 29 productos que se venden por unidad en la balanza y figuran por kg en Patagonia (stock 0, sin movimientos) | Cambiar la forma de venta con la edición normal de producto. Sin efectos sobre stock ni ventas. | Dueño autoriza; lo hacemos nosotros |
| 96 BOCADITOS MUZZA | Sugerido: Patagonia 102 (mismo nombre y forma de venta) | Confirmar con "Guardar" |
| 98 ARABES, 100 PASCUALINAS | Sugeridos (después de corregir las 29): 78 y 80, nombre idéntico. Son el mismo producto con otro precio, y comparten stock | Confirmar |
| 97, 99, 101, 102, 103 | Sin sugerencia (nombres ambiguos: "ARABES X 5" ≠ "ARABES X 5 EFECTIVO") | Cliente, 1 pregunta cada uno |
| 201 | Se lee su nombre de la balanza en la misma sesión (solo lectura) | Después, como cualquiera |
| 8001/8002 (venta libre) | Se cobran por su importe, sin stock | Nada |
| Cajones vs kilos (ej. CAJON PATA MUSLO x15 y PATA MUSLO x5x10) | Si un cajón descuenta kilos del mismo producto, se configura como presentación (stock compartido, factor 15). Si no, queda como producto aparte | Cliente, decisión de negocio |

Las sugerencias son conservadoras (`link-suggest.ts`, probado con nombres reales). "MOLIDA x1" no sugiere "MOLIDA x5".

**Stock inicial:**
- Hoy todos sus productos tienen stock 0.
- Contar lo físico es información del negocio y solo la tiene el cliente.
- Para que sea corto: con **22 productos se cubre el 95 % de lo que venden**, según la semana real. Le mandamos una planilla ya armada (código, nombre, unidad) para la pantalla existente Importar → Productos, que ya carga stock. El cliente solo escribe las cantidades.
- Si no cuenta, Patagonia igual registra cada descuento, y el stock se corrige con el primer conteo.

## 3. Plan

| Fase | Qué | Quién | Tiempo | Requiere |
|---|---|---|---|---|
| 0 | Conectar los botones de las etapas 1 y 2 y el lote al panel (siguen bloqueados) + prueba de pantalla con la balanza simulada | Nosotros, staging | 1 a 2 h | Nada |
| 1 | Publicar la web. Aplicar la migración 119 en producción (solo agrega). Cargar el catálogo real y los vínculos de los 66. Preparar la planilla de stock | Nosotros | 45 min | **Tu autorización (publicar y producción)** |
| 2 | Decisiones de catálogo (29 formas de venta, 96–103, cajones) | Llamada corta con el cliente | 15 min | — |
| 3 | Sesión con el local cerrado y la PC del local prendida con acceso remoto: lectura completa → etapa 1 → etapa 2 → lote de los 87 → relectura completa | Nosotros, por acceso remoto | 30–40 min (el lote ≈ 5 min) | **Tu autorización expresa de escritura** |
| 4 | Primer día: venta normal. Los primeros tickets confirman cómo pone las unidades y que el lector los lee. Cierre: comparamos el reporte de la balanza contra Mostrador | Cliente vende; nosotros controlamos | 1 día | — |

El cliente no tiene que hacer nada técnico: decide su catálogo, cuenta su stock y deja la PC prendida para la fase 3.

## 4. Riesgos y recuperación

| Riesgo | Probabilidad | Qué pasa | Recuperación |
|---|---|---|---|
| La balanza rechaza la escritura | Media (primera vez) | No guarda nada (E5/E8) | Se prueba la otra forma; si no, se frena. Nada que recuperar |
| Una escritura cambia otro dato del producto | Baja | Se detecta al releer | Restauración automática de ese producto desde el respaldo, y se frena el lote |
| Se corta el cable o la luz en medio del lote | Baja | Un producto puede quedar a medias | Al reconectar, "Comparar con el respaldo" y "Restaurar" de los que difieran (probado en simulación) |
| Reescribir pone en cero los totales de la balanza | Desconocida | Afecta solo los informes propios de la balanza, no las ventas ni el historial de tickets | Hacerlo después del cierre de ventas del cliente. La etapa 2 en un producto sin ventas lo muestra antes del lote |
| La balanza codifica las unidades de otra forma | Baja | Mostrador no carga y avisa (no carga mal) | Ajuste de código sin tocar la balanza |
| Precios cambiados en la balanza sin volver a leerla | Media | Mostrador pide más importes del papel (no cobra mal) | Volver a leer la balanza (solo lectura, 1 clic) |
| Hay que volver todo atrás | — | — | Balanza: "Restaurar desde el respaldo" (todos los productos como estaban). Web: volver a la versión anterior en Netlify. Función de venta: borrar la fila de `scale_profiles` (Mostrador vuelve a funcionar como hoy). Ventas: "Anular" (devuelve el stock) |

## 5. Para el próximo cliente Systel
Es la misma herramienta y la misma pantalla, y nada es específico de Los gringos:
1. Leer la balanza (solo lectura).
2. Guardar el catálogo.
3. Vincular los productos.
4. Etapa 1 (si es otro modelo o firmware).
5. Lote.
6. Planilla de stock.

La forma del tipo de código confirmada en la etapa 1 queda guardada por modelo y protocolo (firma de la balanza).
