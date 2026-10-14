# Arquitectura de venta con balanzas (Patagonia System)

14/10/2026. **Propuesta para aprobar: no hay nada construido ni publicado.** Vale para Systel, Kretz y cualquier otra marca.

Objetivo: el cajero escanea, cobra y el stock baja en ese momento, con producto, kilos o unidades e importe correctos. Sin duplicados, con varios vendedores y sin depender de la conexión con la balanza al cobrar.

## 1. Principio

Lo único que Mostrador recibe con certeza en el momento de cobrar es **lo que está impreso en el código de barras**. Leer la balanza al cobrar no es confiable: la Systel contesta E3 en horario de atención.

Por eso cada balanza se describe por lo que su código de barras trae de verdad, y la modalidad de cobro sale de eso, no de la marca:

| El código del TOTAL trae… | Cada artículo trae… | Modalidad |
|---|---|---|
| un **N.º de ticket único** y la balanza entrega el detalle por ese número | — | **A. Un solo código** (detalle por identificador, nunca por importe/hora) |
| solo importe (y cantidad de artículos) | producto + **cantidad** | **B. Artículos + TOTAL** (stock exacto, importe validado contra el TOTAL) |
| solo importe | producto + **importe** | **B'.** Importe exacto; la cantidad sale de importe ÷ precio. Solo es válido si el producto tiene **un único precio** en la balanza |
| solo importe | nada | **No apto** para descontar stock: cobra el total sin stock (como hoy) y lo avisa |

## 2. Viabilidad comprobada para Systel Cuora Max

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿El código del TOTAL puede traer el N.º de ticket? | **No.** Solo admite números fijos, I (importe), B (N.º de balanza) y A (artículos). | Protocolo V6.0/V7.0, función 8; manual Cuora Max, "Configuración del código de barras", págs. 41–43 |
| ¿Hay un N.º de ticket y su detalle? | **Sí**, pero solo dentro de la balanza: función 72 (N.º de ticket, fecha, hora, vendedor, PLU, unidades o gramos, importe). | Real: 1.430 artículos del 07 al 13/10 |
| ¿Se puede unir el papel con ese N.º sin usar importe y hora? | **No.** Ningún código impreso trae el N.º. | Lo anterior |
| ¿Qendra exporta ventas? | No está documentado: Qendra solo **importa** productos (CSV). | Qendra "Importación automática" Rev 2 |
| ¿Cada artículo puede traer producto + cantidad? | **Sí.** Campos P y C, por producto (EAN del PLU) o general. | Protocolo 61/62; manual; real: PLU 13, 14, 50 y 51 de esta balanza; etiquetas reales de otro cliente Systel |
| ¿Se configura sin escribir desde la PC? | **Sí**, desde el menú de la balanza: "editar PLU → CONFIGURAR EAN". Los 4 productos que ya lo tienen se hicieron así (gestión 0). | Manual, "editar/crear PLU" |
| ¿Alcanza el formato general actual (20PPPPCCCCII)? | **No.** 4 cifras = hasta 9,999 kg, y 57 de 1.003 ventas por peso reales superan 10 kg. Hace falta CCCCCC. | Reporte real |

**Conclusión:**
- La modalidad **A no es posible con la Cuora Max.** No hay identificador del ticket en el papel, y adivinarlo por importe y hora queda descartado por definición.
- La modalidad **B sí es posible**, con un cambio de configuración por producto en la balanza, hecho una sola vez.
- Queda una consulta formal a Systel (sección 7) por si existe un firmware o un software que imprima el N.º de ticket.

### B con la semana real de Los gringos (945 tickets, cada código simulado a partir del reporte real)

| Resultado | Tickets |
|---|---|
| Importe de cada artículo deducido = el de la balanza | 860 |
| Pide copiar los importes del papel (precio manual, cambio de precio o empate) | 29 |
| Productos que Patagonia todavía no conoce (PLU 201) | 39 |
| Con venta libre de la balanza (8001/8002) | 16 |
| Combinación única pero no era la real | **1** (dos cajones a $74.000 + $70.000 a mano, deducidos como $72.000 + $72.000) |

- En todos los casos el **producto, la cantidad, el stock y el total del ticket son exactos**, porque salen del código y no se deducen.
- El caso de "combinación única pero no real" solo cambia el reparto entre dos líneas **del mismo producto**: no afecta ningún informe por producto.
- Se elimina del todo si el cliente deshabilita los precios manuales en la balanza. Es decisión comercial del cliente; nosotros no tocamos esa configuración.

## 3. Componentes

```
Balanza ──(código impreso)──► Lector ──► Mostrador
   │                                   │
   │ lectura solo-lectura              ▼
   │ (catálogo, precios,       ScaleTicketAssembler (puro)
   │  reporte de ventas)        ├─ Codecs por perfil de balanza
   ▼                            ├─ Liquidación (importes)
ScaleDriver (por marca)         └─ Huella del papel
   │                                   │
   ▼                                   ▼
scale_profiles / scale_product_links / scale_price_snapshots     create_pos_sale
(servidor, compartido por todas las PC de la sucursal)          + scale_ticket_claims (misma transacción)
                                                                + stock inmediato
```

1. **`ScaleDriver`** (ya existe en `features/scales/`; se amplía). Por marca y modelo declara:
   - `labelProfile`: qué traen sus códigos (TOTAL con o sin N.º de ticket; artículo con cantidad o importe);
   - `priceLists`: cuántas listas de precios tiene;
   - `readCatalog`: productos y precios, solo lectura;
   - `readSalesLog`: reporte de ventas, solo para control;
   - `readTicketById`: solo si existe la modalidad A;
   - escrituras: cada una con respaldo, verificación y restauración, y bloqueada salvo evidencia real del modelo **y** autorización por empresa.
2. **Codecs** (puros, con pruebas). Convierten un código escaneado en un evento: `artículo {balanza, PLU, cantidad?, importe?}`, `total {balanza?, importe, artículos?, ticketId?}` o `desconocido`. Reemplazan la lectura actual repartida en `scale-barcode.ts`, `systel-label-format.ts` y `kretz/aura-barcode.ts`, con el mismo comportamiento probado.
3. **`ScaleTicketAssembler`** (puro, con pruebas). Es la máquina de estados del ticket en Mostrador:
   - **abierto:** llegan artículos de un mismo papel;
   - **TOTAL:** cierra el papel y valida que la cantidad de artículos coincida y que la suma sea exacta;
   - **confirmado:** recién ahí se puede cobrar.
   - Un TOTAL que no cierra exacto no confirma nada y no se descarta nada. Se puede cancelar el papel entero.
   - **Liquidación del importe por artículo**, en este orden:
     1. el que trae el código;
     2. una única combinación exacta con las listas de la balanza;
     3. copiado del papel, que debe sumar el TOTAL.
     
     Nunca proporcional, nunca por importe y hora.
4. **Vínculo balanza ↔ producto (`scale_product_links`).** Reemplaza "mismo código + nombre parecido":
   - campos: balanza, PLU → producto de Patagonia, forma de venta y nombre de la balanza al momento del vínculo;
   - se arma una vez, en una pantalla de vinculación con las diferencias a la vista. Los productos 96–103 y las 29 unidades se resuelven ahí, no en la caja;
   - las ventas libres (PLU genéricos) se vinculan a "Venta libre balanza": se cobra el importe y no hay stock.
5. **Precios de la balanza en el servidor (`scale_price_snapshots`).** Se leen solo-lectura y los usan todas las PC de la sucursal. Si una PC nunca leyó la balanza, igual sabe los precios.
6. **Cero duplicados (`scale_ticket_claims`).**
   - Se escribe dentro de la misma transacción de `create_pos_sale`.
   - **Modalidad A:** índice único `(empresa, balanza, fecha, N.º de ticket)`, imposible de cobrar dos veces desde dos PC.
   - **Modalidad B:** el papel no tiene identificador, así que se guarda la **huella** (código del TOTAL + códigos de los artículos + día). Si se repite, el cajero tiene que confirmar "es otro ticket igual" y queda registrado quién lo confirmó. Dos clientes pueden llevar exactamente lo mismo, por eso no se bloquea.
   - Los reintentos sin conexión ya son seguros con `p_idempotency_key` (migración 087).
7. **Control diario (solo lectura, al cierre).** Al cerrar la caja se lee el reporte de la balanza y se compara **por producto** (kg, unidades e importe) contra lo cobrado en Mostrador. No une tickets: suma. Así aparece, por ejemplo, un papel impreso y no cobrado o un precio manual mal copiado, y queda registrado como hoy el control de cierre de la Kretz.

## 4. Cómo cumple cada prioridad

| Prioridad | Cómo |
|---|---|
| 1. Exactitud de ventas y stock | Producto y cantidad salen del código impreso. El stock baja en `create_pos_sale` al cobrar. Ningún importe se adivina. |
| 2. Rapidez | Sin conexión con la balanza al cobrar. Un papel de N artículos = N+1 lecturas del lector. Con la modalidad A, 1 sola. |
| 3. Cero duplicados | Claims en la misma transacción, idempotencia, y la huella con confirmación explícita. |
| 4. Precios minorista, mayorista y manual | Listas de la balanza en el servidor, combinación exacta única, y el papel para lo manual. El control diario detecta diferencias. |
| 5. Varios vendedores | Cada papel es independiente. El TOTAL valida cuántos artículos tiene, así que mezclar dos papeles no confirma. |
| 6. Fallas de conexión | El cobro no depende de la balanza. Cola sin conexión con idempotencia. El vínculo y los precios están en el servidor. |
| 7. Nada peligroso en la balanza | Lectura por defecto. Configuración única por el menú oficial o, con autorización, por la escritura preparada (respaldo, verificación y restauración). Nunca funciones de borrado ni de cierre. |

## 5. Por marca

| Marca y modelo | Modalidad posible hoy | Qué falta |
|---|---|---|
| **Systel Cuora Max** | B (artículo = producto + cantidad) | Configurar el código por producto (menú o escritura autorizada) y hacer la vinculación |
| Systel Cuora Neo | A desconocida | Documentación de Systel |
| **Kretz Aura** | B' (artículo = producto + importe, 1080) | Confirmar en una Aura real. Válido solo con producto de un único precio, si no la cantidad no es exacta |
| Kretz Report LT | B' / TOTAL sin stock | Igual que Aura |
| Otras marcas | Las que impriman N.º de ticket en el código y lo entreguen por protocolo → A | Driver nuevo: un archivo y una línea en el registro |

## 6. Plan de implementación (nada en producción sin autorización)

| Fase | Qué | Dónde | Cómo se comprueba |
|---|---|---|---|
| 0 | Consulta formal a Systel (sección 7) | Mail del dueño | Respuesta escrita |
| 1 | Codecs + Assembler + liquidación (puro) y migración de los lectores actuales | Código | Las pruebas actuales de Kretz y Systel sin cambios, más los 945 tickets reales repetidos como escaneos |
| 2 | `scale_product_links`, `scale_price_snapshots`, `scale_ticket_claims` y `create_pos_sale` con claims en la misma transacción | **Staging** | Pruebas SQL con dos sesiones a la vez (dos PC) y reintentos sin conexión |
| 3 | Pantalla de vinculación + Mostrador unificado + control diario | Staging (Don Julio) | Pantalla real con Playwright: los tickets reales 3087, 3095 y 3098, papel repetido, papel mezclado, precio manual |
| 4 | Kretz sobre la nueva base | Staging | Las mismas pruebas de Aura y Report, idénticas |
| 5 | Los gringos: vinculación (decisiones del cliente sobre 96–103 y 201) y configuración del código por producto | Autorización por separado | Respaldo verificado; 1 producto primero |
| 6 | Piloto en producción solo para Los gringos, con vuelta atrás | Autorización por separado | Primer día: el control diario sin diferencias |

## 7. Consulta a Systel (borrador para que la mande el dueño a postventa@systel.com.ar)

> Somos integradores de un sistema de punto de venta usado por clientes con Cuora Max (protocolo 0060, 8.000 PLU). Consultas puntuales:
> 1. ¿Existe algún firmware o configuración de la Cuora Max (o Cuora Neo) que incluya el **número de ticket** en el código de barras del ticket de suma?
> 2. En la función 61, ¿reescribir un PLU existente pone en cero sus totalizadores de venta? ¿Lleva byte de verificación? ¿El campo "Configuración EAN utilizada" va como dígito ASCII o como byte (la función 62 lo devuelve como 0x01)?
> 3. ¿El reporte de la función 72 se borra con el cierre de ventas (función 32) o al llegar a cierta cantidad? ¿Cuántos tickets guarda?
> 4. ¿El error E3 aparece mientras hay un ticket abierto en algún vendedor?
> 5. ¿Qendra o algún software de Systel exporta las ventas por ticket?
