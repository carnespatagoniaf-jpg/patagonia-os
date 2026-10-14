# Los gringos (Systel Cuora Max): análisis y solución

14/10/2026. Hecho solo con evidencia que ya teníamos (sin pedir pruebas al cliente). La evidencia está en:
- los reportes a soporte de la tabla `scale_support_reports`;
- el reporte de ventas real de su balanza (1.430 artículos, 07–13/10);
- los 103 registros de productos (función 62) leídos el 14/10;
- los protocolos y el manual oficiales de Systel.

## 1. Hechos comprobados (con datos reales)

| Hecho | Evidencia |
|---|---|
| Comunicación por USB FTDI (COM3), 115200 8N1, balanza N.º 20. Cuora Max, protocolo 0060, 30 kg, 8.000 PLU, precios sin decimales. | Firma real (función 2), lecturas del 09, 13 y 14/10. |
| **E7 en la 72 = rango inválido.** La fecha de fin NO se incluye: `141026141026` → E7 y `141026151026` → reporte válido. Sin ventas en el rango, la respuesta es solo `F`. | Diagnóstico real del 14/10 09:19. |
| **El reporte de ventas existe y es completo:** 1.430 artículos en 945 tickets. Difiere del documento en dos cosas: el PLU viene con 4 cifras y hay un `;` entre artículos. **Numera por ticket.** | Diagnóstico real del 14/10 09:53. El ticket 3095 de la foto aparece exacto: PLU 5 215 g $1.118 + PLU 2 1 u. $72.000. |
| **Causa del código en ceros debajo de cada artículo:** cada producto tiene su propio "código propio" (tipo EAN 0x01). En 87 productos es `000000000000`. 4 tienen uno útil: 13 y 14 `20PPPPCCCCCC`, 50 y 51 `21PPPPCCCCCC`. 12 usan el general `20PPPPCCCCII`. | Los 103 registros 62 reales. |
| **Precios:** solo el 54 % de los artículos se cobró a lista 1; el 42 % a lista 2 (mayorista) y el 4 % a otro precio (manual o cambiado durante la semana). | Reporte real cruzado con los precios de la balanza. |
| Catálogo Patagonia ↔ balanza: los códigos 1–95 son el mismo producto. **96–103 son productos distintos.** 29 productos se venden por unidad en la balanza y figuran por kg en Patagonia (stock 0, sin movimientos). Los PLU 201, 8001 y 8002 no existen en Patagonia. | Nombres y tipos reales. |
| Nuestra comunicación no deja bytes sin leer y no hubo cortes. | Eventos de línea: ningún "descartado". |

## 2. E3: hipótesis fuerte, no comprobada

**E3 ("se desatendieron datos")** apareció en 13 sesiones; la balanza contesta E3 a todo, incluso al ping. Cruzado con la hora de cada ticket real (reloj de la balanza +11 min):

| Sesión | Resultado | Tickets alrededor |
|---|---|---|
| 13/10 12:03 | OK | ticket impreso 18 s antes |
| 13/10 12:04–12:05 | E3 | próximo ticket 20 min después |
| 13/10 12:26 | E3 | tickets a las 12:25 y 12:27 |
| 13/10 12:27 | OK | ticket impreso 21 s antes |
| 09/10 13:19 | OK | — |
| 09/10 13:37–13:52 | E3 | próximo ticket 13:57 |
| 14/10 09:19 y 09:53 | OK | local sin clientes |
| 14/10 10:25–10:29 | E3 | durante la prueba en el local |

- **Hipótesis:** la balanza no atiende a la PC mientras hay una operación abierta (ticket en curso). Es consistente con los 9 casos cruzados y con el documento ("en medio de una transacción (ticket abierto) … el equipo responderá con Error", función 40). Confirmarla exige ver la balanza mientras ocurre.
- **Consecuencia práctica:** leer la balanza al momento de cobrar NO es confiable en horario de atención.

## 3. Alternativas evaluadas

| Alternativa | Producto y cantidad | Importe | Depende de la conexión al cobrar | Veredicto |
|---|---|---|---|---|
| A. Leer el ticket de la balanza (72) al escanear el TOTAL | exactos | exacto | **sí** (E3 en horario de atención) | Complemento, no base |
| B. Leer la 72 en segundo plano cuando la balanza está libre | exactos | exacto | sí (ventanas libres) | Posible mejora; no comprobado cuánto tarda en liberarse |
| C. Código de cada producto en el ticket + código del TOTAL | **exactos** | **deducido** (ver 4) | **no** | **Elegida** |
| D. Código con importe en vez de cantidad | cantidad = importe ÷ precio | exacto | no | Descartada: con 2 listas y precio manual la cantidad sale mal |
| E. Precio de Patagonia o lista 1 para todo | exactos | mal en ~46 % | no | Descartada |

## 4. La solución elegida (C), validada con datos reales

1. **En la balanza, una sola vez:** cada producto con su código propio `20PPPPCCCCCC` (pesables) o `21PPPPCCCCCC` (unitarios): producto (4) + cantidad (6, gramos o unidades). Es el formato que su balanza ya usa en 13, 14, 50 y 51, y el que imprime la Systel de TripleS (etiquetas reales leídas bien).
2. **En Mostrador, sin conexión con la balanza:**
   - se escanea el código de cada artículo (producto + cantidad exactos; queda "esperando el TOTAL");
   - después se escanea el código del TOTAL (importe y cantidad de artículos);
   - Patagonia busca qué precio (lista 1 o 2 de la balanza) se usó en cada artículo para que sume **exactamente** el total (`systel-ticket-settle.ts`).

**Validación sobre las 1.430 ventas reales:**
- en 860 de 861 tickets explicables, el importe deducido de cada artículo es **idéntico** al que cobró la balanza;
- el restante (dos cajones a $74.000 y $70.000, precio manual) da el total exacto, con el reparto entre artículos proporcional y marcado;
- tickets con precio manual o cambiado: total exacto, reparto proporcional y marcado;
- en ningún caso cambia el producto, la cantidad ni el stock.

**Controles:**
- no se puede cobrar sin escanear el TOTAL;
- si la cantidad de artículos no coincide con el TOTAL, no confirma;
- el mismo papel escaneado de nuevo en otra venta del día pide confirmación;
- el código de cada producto se lee con el formato de ESE producto (`systel-label-format.ts`);
- el vínculo con Patagonia exige código + forma de venta + nombre;
- todo solo para la empresa piloto.

**Pruebas:**
- automáticas: 538, incluidas las de datos reales (reporte, registros 62, ticket 3095);
- pantalla real de Mostrador en staging, SIN balanza (`tests/e2e/ui-codigo-por-producto-total.mts`), con los tickets reales 3095 y 3087;
  - el 3087 con un artículo a lista 2 dio $68.000, igual que la balanza;
  - el stock bajó lo vendido; no deja cobrar sin TOTAL; frena el reescaneo; frena si falta un artículo.

## 5. Cambiar el código en la balanza desde Patagonia (preparado, NO ejecutado)

`systel-product-barcode.ts`:
1. **Respaldo:** lee y guarda los 103 productos completos.
2. **Por cada producto:** escribe (61) EXACTAMENTE lo leído, sin el carácter de gestión que la escritura no lleva, cambiando solo los 12 caracteres del código propio. El byte del tipo queda como lo guarda la balanza (0x01).
3. **Comprobación:** relee y compara byte por byte; solo pueden cambiar el código, el tipo y la gestión.
4. **Si cambió otra cosa:** reescribe el registro original y frena.
5. **Prueba:** primero 1 producto, después el resto, frenando en el primero que no quede confirmado.

Probado contra los registros reales de los PLU 2 y 13 en la balanza simulada: precios y nombre intactos, rechazo (E5), corrupción con restauración, bloqueo si la escritura no está habilitada.

**Lo único que no se puede comprobar sin la balanza:**
- que la balanza acepte la escritura 61 así (el documento V6.0 no muestra el byte de control en la 61; usamos la regla general, con byte de control);
- que después imprima el código debajo de cada artículo (`ETi=S` ya está activado).

## 6. Procedimiento de implementación seguro

1. Autorización del dueño.
2. Publicar la versión con Mostrador (C). Solo afecta a Los gringos; sin el cambio en la balanza no cambia nada: las etiquetas siguen saliendo en ceros y se cobra como hoy.
3. Con el local cerrado o sin clientes (sin tickets abiertos): Stock → Balanza → cambiar el código de **1 producto** (trozadito). Si queda "confirmado", imprimir un ticket de prueba **sin cobrar** y escanear su código en Mostrador.
4. Si lee producto y kilos, aplicar al resto; frena solo ante cualquier diferencia.
5. Ajustar la sucursal en Patagonia al formato 2/4/6.
6. Pendientes de catálogo, para cubrir el 100 %, con autorización:
   - pasar los 29 productos "por unidad" a "por unidad" en Patagonia;
   - decidir los códigos 96–103;
   - crear 201, 8001 y 8002.

**Volver atrás:**
- balanza: reescribir el respaldo del paso 3;
- página: republicar la versión anterior en Netlify;
- sucursal: valor anterior en `audit_log`.

## 7. Revisión del 14/10 (tarde): datos, protocolo y alternativa "solo el TOTAL"

Hecho solo con evidencia existente. No se escribió nada en la balanza ni en los datos del cliente. No se publicó nada.

### 7.1 Catálogo balanza ↔ Patagonia (103 registros 62 reales vs catálogo de producción del 14/10)

- **66 iguales** (código, nombre y forma de venta).
- **29 por unidad en la balanza y por kg en Patagonia:** 30, 62–85, 92–95. Todos tienen stock 0 y ningún movimiento en Patagonia, así que cambiarlos no afecta stock ni ventas. Es dato comercial: requiere autorización.
- **96–103 son otros productos.** En la balanza: 96 BOCADITOS MUZZA (P), 97 BOCADITOS CAJA (U), 98 ARABES, 99 ARABES X 5, 100 PASCUALINAS, 101 PASCUALINAS X5, 102 COMBO 1, 103 COMBO 2. En Patagonia son los "MAYORISTA" y los bocaditos. El 98–103 de la balanza repite nombres del 78–83 con otros precios. No se puede decidir con certeza: lo decide el dueño o el cliente.
- **8001 y 8002 no son productos:** son los PLU genéricos de la balanza (venta libre con precio a mano).
  - Fuera de la memoria de 8.000 PLU, sector 00, un precio distinto en cada venta.
  - 8001 = por unidad (6 ventas), 8002 = por peso (11 ventas).
  - Patagonia no puede descontar stock por ellos: van como "venta sin producto" con el importe exacto.
- **201 existe en la balanza** (lista de PLU del 09/10) y vende 1 u. a $500 (40 ventas en la semana). No tenemos su nombre (nunca se leyó su registro 62), así que no se puede crear con certeza.
- **La balanza tiene más PLU** que Patagonia (104–128, 200, 201, 400–405, 500–503…). En la semana solo se vendió el 201.
- **Cobertura con el reporte real (945 tickets):**

  | Situación del catálogo | Tickets que se pueden vincular completos |
  |---|---|
  | Hoy | 821 (86,9 %) |
  | Corrigiendo los 29 | 882 (93,3 %) |
  | Más el 201 | 921 (97,5 %) |

  Quedan 16 con genéricos y 8 con una línea de $0.

### 7.2 Protocolo: lo que encontramos al releer V6.0/V7.0 y el manual

- **El código propio de cada PLU se configura también desde el menú de la balanza.** Manual, "editar/crear PLU": "1. USAR EAN GRAL. / 2. CONFIGURAR EAN / 3. NO USAR EAN".
  - Los 4 productos que ya lo tienen (13, 14, 50, 51) tienen gestión 0, es decir que se hicieron en la balanza, no desde una PC.
  - Es la vía oficial y sin riesgo de protocolo, pero hay que hacerla a mano producto por producto.
- **El formato general actual no alcanza.** E_P=20PPPPCCCCII trae 4 cifras de cantidad (hasta 9,999 kg), y 57 de 1.003 ventas por peso reales superan los 10 kg (máximo 14,935 kg). Hace falta CCCCCC: el código propio por producto, o cambiar el general.
- **Función 61 (riesgos no resueltos por el documento):**
  1. No lleva el campo "Mantener totales" (N/M) que sí tiene la función 4. No se sabe si reescribir un PLU pone en cero sus acumulados de venta en la balanza.
  2. El documento dice que el tipo de EAN es "1 número", pero la balanza lo devuelve como byte binario 0x01. No se sabe cuál de los dos acepta al escribir. Nosotros mandamos 0x01, como lo devuelve.
  3. El texto de la 61 no incluye el byte de verificación. Nosotros lo mandamos y reintentamos sin él ante E5.
- **Hubo una PC escribiendo en esta balanza:** PLU 29–31, 34, 62, 63, 67, 68, 98–111, 400–405 y 500–503 tienen versión 1 ("gestionado PC"), probablemente Qendra. Si ese programa sigue sincronizando, puede pisar cualquier cambio nuestro.
- **El código del TOTAL no puede traer el número de ticket.** Los campos posibles son números fijos, I (importe), B (balanza) y A (artículos).
- La configuración real tiene Sinc=0: la balanza no queda bloqueada esperando sincronización al encenderse.

### 7.3 Alternativa "solo el TOTAL" (A diferida), simulada con la semana real

**Idea:**
- el cajero escanea solo el código del TOTAL, como hoy;
- la venta se cobra con el importe exacto;
- el detalle (productos, kilos, unidades, importes reales de lista 1, lista 2 o manual) se lee después con la función 72, solo lectura, al cerrar la caja o cuando la balanza está libre, y recién ahí se descuenta el stock.

**Vínculo de cada cobro con su ticket:** mismo TOTAL, misma cantidad de artículos y el ticket impreso más cercano antes del cobro. Se corrige el reloj leyendo la hora de la balanza (función 28).

**Resultado sobre los 945 tickets reales (simulación del momento de cobro):**

| Demora en cobrar | Impresos sin cobrar | Error de reloj | Cobros con el contenido correcto |
|---|---|---|---|
| hasta 2 min | 0 % | 0 | 945 de 945 |
| hasta 5 min | 0 % | 0 | 945 de 945 |
| hasta 10 min | 5 % | +4 min | 896 de 896 |
| hasta 15 min | 10 % | −4 min | 858 de 858 |

- **Por qué funciona:** 801 tickets tienen un TOTAL+cantidad único en el día. 130 se repiten pero con el mismo contenido, así que da igual cuál se tome. Solo 14 (5 grupos) se repiten con distinto contenido, y están separados por 43 min o más.
- **Ventajas sobre C:**
  - no hay que escribir en la balanza;
  - el cajero escanea un solo código;
  - el importe de cada artículo es el real, sin deducirlo.
- **Costo:** el stock baja al leer (al cierre), no en el momento.
- **Requiere:** una migración (venta con "detalle pendiente" + una RPC que lo complete y descuente stock), la lectura al cierre y una pantalla de revisión para lo que no se vincule (nunca se adivina).
- **No construido. Requiere autorización.**
- **Evidencia de que la lectura funciona con el local tranquilo:** lecturas reales completas el 13/10 12:03 y 12:27 y el 14/10 09:19 y 09:53.
- **Sin confirmar:**
  - que la lectura funcione siempre al cierre;
  - que la balanza conserve el historial hasta leerlo. El 14/10 tenía desde el 07/10. No se sabe si su "cierre de ventas" lo borra.
