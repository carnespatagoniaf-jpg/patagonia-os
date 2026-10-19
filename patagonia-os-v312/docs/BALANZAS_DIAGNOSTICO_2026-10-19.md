# Balanzas: diagnóstico de la implementación (19/10/2026)

Hecho a pedido del dueño después de no poder conectar la Systel de Los gringos por AnyDesk. Revisé el código, las
pruebas y los datos reales de producción. Cada afirmación lleva su archivo o su consulta.

## 1. Qué está implementado y qué está comprobado

"Real" = visto en una balanza física de un cliente. "Simulado" = solo pruebas con una balanza falsa hecha a partir del
manual. Fuente principal: `apps/web/src/features/scales/engine/capabilities.ts`.

| Función | Kretz Report LT | Kretz Aura | Systel Cuora Max |
|---|---|---|---|
| Conectar e identificar | real (Carnes Patagonia) | real (Pollo y mar) | real (Los gringos 14/10), hoy falla: ver §4 |
| Leer los productos de la balanza | real | real | real (103 productos) |
| Mandar productos y precios, con relectura | real (2005 + 5005) | real (223 productos, 05/10) | **simulado** para productos existentes; real para crear productos de prueba (7995–7999) |
| Código de barras por producto en el ticket | no | **no: la Aura rechazó el 1080** (respuesta 02, 15/10) | real (función 61, 14/10) |
| Leer la etiqueta de un producto en Mostrador | real (29 etiquetas) | real solo en Pre-Empaque (1 ticket por producto) | real (TripleS y Los gringos) |
| Ticket con varios productos (TOTAL) | no hay tratamiento | se cobra como plata, **sin producto ni stock** | piloto: leer por cable (función 72) o escanear artículos + TOTAL |
| Descontar stock | sí, por etiqueta | solo Pre-Empaque, y los kg salen de importe ÷ precio de Patagonia | sí, por etiqueta |

Producción, últimos 21 días (`pos_sale_items.source`):
- Carnes Patagonia: 2.119 líneas escaneadas de etiquetas (Report LT). El circuito completo funciona.
- Pollo y mar: 338 líneas por etiqueta y **7 ventas cobradas solo con el TOTAL, que no descontaron stock**. En 7 días quedaron 11 líneas sin producto.
- Los gringos: 2 ventas de prueba el 14/10. **En la práctica no vende escaneando.**
- `scale_profiles` (la tabla de balanzas de venta) tiene **una sola fila en toda la base**: Los gringos, con `scale_key = 'systel'` fijo.

## 2. Por qué cuesta tanto instalar una balanza

1. **Hay cinco pantallas distintas.** Mi balanza (la que ve el cliente), ScaleSyncPanel y SystelPanel (soporte),
   Scales.tsx (oculta) y la configuración de Mostrador (calibración de etiquetas y peso de la Aura). Cada una elige el
   puerto con una regla distinta:
   - lo recordado por USB o la lista de puertos;
   - `getPorts()[0]`;
   - "un solo FTDI";
   - preguntando el peso.
2. **Todo supone una sola balanza.** Hay 20 claves de `localStorage`, y todas guardan un solo valor por computadora
   (`patagonia-my-scale`, `patagonia-systel-link`, `patagonia-scale-serial-settings`…). Además:
   - `branch_scale_configs` es una fila por sucursal, y la pisan la Aura, la calibración de Mostrador y ScaleSyncPanel.
   - `scale_key` está escrito a mano como `"systel"`.
   - `loadScaleSetup` devuelve `null` si una sucursal tiene dos balanzas, y eso apaga la venta con balanza de toda la sucursal (`scale-sale-service.ts:56`).
3. **No hay forma de distinguir dos adaptadores USB iguales.** Se reconoce el puerto solo por fabricante:producto
   (`engine.ts:31`), así que dos FTDI iguales se confunden.
4. **Mostrador deja tomado el cable de la Systel todo el tiempo que está abierto** (`systel-ticket-from-scale.ts:69`,
   con el lector bloqueado). Cualquier otra pestaña da "puerto ocupado". El aviso entre pestañas (`serial-tabs.ts`) lo
   usa solo la Kretz, y no puede liberar un lector bloqueado.
5. **El reporte de error no sirve para diagnosticar.** Si Mi balanza no conecta, el reporte dice "ninguna marca
   contestó": no lleva el intercambio de bytes ni qué puerto se eligió (`adapters/systel.ts:200` descarta el registro).
   Por eso hoy hubo que pedirle pruebas al cliente.
6. **Errores mal clasificados.** `friendlyKind` toma cualquier "NetworkError" como "otra pestaña", también cuando falta internet (`friendly.ts:28`).

## 3. Lo de hoy en Los gringos

- 11:02 y 11:04: "no contestó", con todas las velocidades y direcciones. No quedó registrado qué puerto se eligió.
- 11:12 y 11:30: "Failed to open serial port", es decir, otra pestaña o programa tiene el puerto. En la foto se ve otra ventana de Patagonia detrás.
- La explicación más probable es la del punto 2.4 (Mostrador abierto en otra ventana). Lo de las 11:02 no se puede confirmar sin el registro del punto 2.5.

## 4. Tickets con varios productos

- **Systel Cuora Max:**
  - El código del TOTAL no puede llevar el número de ticket (manual, función 8). Lo que sí es real: cada producto puede
    imprimir su propio código, y la balanza tiene un reporte de ventas por cable (función 72: 1.430 artículos leídos el 14/10).
  - Leer ese reporte en el momento de cobrar no es confiable: devuelve E3 en horario de atención.
  - Camino confiable: **escanear los productos del ticket + el TOTAL**, y que Patagonia compruebe que la suma da el
    TOTAL (migración 119, en producción). Hoy está limitado a las empresas piloto.
- **Kretz Aura:**
  - El ticket de suma trae solo el TOTAL (manual §7.1.7).
  - El comando para imprimir un código por producto (1080) fue rechazado por la balanza real.
  - No hay ningún comando documentado que devuelva el detalle de un ticket: 5008 da totales por PLU y para recorrerlos
    hay que borrar (3008), así que no se usa.
  - Es una limitación real del equipo. Se le consultó a Kretz el 15/10 y no respondió todavía.
  - Alternativa sin Pre-Empaque: al escanear el TOTAL, que Mostrador pida elegir los productos y que la suma tenga que dar el TOTAL.
- **Kretz Report LT:** imprime una etiqueta por producto con peso. El circuito funciona así, y no hay tickets de suma en uso.

## 5. Doble lectura y desconexiones

- La venta en sí no se duplica: tiene una clave única por venta (`pos_sales.idempotency_key`, migración 087), que también cubre la cola sin conexión. El stock se descuenta una vez por línea de producto.
- **Leer dos veces el mismo papel:**
  - Solo está protegido en el servidor el modo "artículos + TOTAL", y solo dentro de 3 minutos.
  - Las etiquetas Kretz no se guardan. Una misma etiqueta escaneada dos veces suma los kg sin avisar, y en otra venta no se detecta.

## 6. Qué se corrige (en este orden)

1. **Registro de balanzas por sucursal.** Cada balanza tiene su nombre, marca, modelo, formato de códigos y estado. Una segunda balanza no pisa a la primera.
2. **En cada computadora, cada balanza tiene su propio puerto**, reconocido por su respuesta (dirección o número) y no solo por el USB.
3. **Un solo dueño del cable a la vez.** Mostrador lo abre solo cuando lo necesita y lo suelta, y las pestañas se coordinan entre sí.
4. **Reporte completo al fallar:** puerto elegido, bytes enviados y recibidos, y en qué paso falló.
5. **Mostrador lee con todas las balanzas activas de la sucursal**, no con una sola.
6. **Ticket de varios productos:** Systel, artículos + TOTAL para todos. Aura, elegir los productos del TOTAL.
7. **Papel repetido:** se guarda el código de cada línea de balanza y el servidor avisa si se cobra de nuevo en el día.

## 7. Los gringos, 19/10: por qué la Systel "no contestó" (análisis de registros)

Fuente: `scale_support_reports` de producción, 18 reportes de ese día, comparados con los del 09, 13 y 14/10.

**Comprobado**
- 11:12 a 12:31: el puerto no abría ("Failed to open serial port", error del sistema operativo).
  - La versión nueva le preguntó a la otra pestaña de Patagonia y esta tenía 0 puertos abiertos (12:24), así que no era Patagonia.
  - Se destrabó cuando el cliente desenchufó y volvió a enchufar el USB (12:35).
- El cable de la balanza es **FT232R USB UART, COM5** (0403:6001), el mismo chip que el 14/10 (entonces COM3). "USB Composite Device, COM4" (1a86:7100) es otro aparato. El cliente lo eligió al menos una vez y ahí la balanza no contestó (12:34).
- 12:43 a 12:50 (4 intentos): la búsqueda **sí encontró una balanza que contestó como N.º 20** (`direccion: 20`). Después no hubo firma (función 2) ni ping (23), cada uno con 5 reintentos durante unos 10 s.
- La versión publicada perdía el detalle de esa lectura: `prepare` cortaba antes de guardar el respaldo, y `supportInfo` quedaba vacío (`firma: null, detalle: null`). Por eso el reporte decía solo "no contestó".
- Una respuesta E3 al ping del N.º 1 hace que la búsqueda tome el número de la trama (20), como si hubiera contestado bien (`pingAt` en systel-discovery.ts). Así se ve el caso en los registros.
- Esta balanza ya tuvo "E3 a todo" 13 veces (09, 13 y 14/10), siempre en horario de atención. Las sesiones buenas del 14/10 fueron de 17:42 a 19:18.

**Hipótesis (sin comprobar)**
- Hoy la balanza contestó **E3** ("se desatendieron datos") y no silencio: mismo número, mismo cable, mismo patrón. No se puede comprobar porque se perdió el registro, y queda probado en el próximo intento con la versión corregida.
- E3 = la balanza ocupada (venta abierta, menú, operando). No está documentado por Systel.
- Es la misma Cuora Max N.º 20 del 14/10, y no una balanza nueva: hoy no se pudo leer su firma ni su modelo. Si es nueva, tiene el número 20 de fábrica.

**Corregido (sin publicar)**
- Ante E1/E2/E3 se muestra "la balanza contestó, pero está ocupada", con qué hacer (pantalla de pesar, sin venta ni menú abiertos), en lugar de "no contestó".
- El reporte a soporte lleva el intercambio de la búsqueda y de la lectura, la firma, el detalle y si contestó "ocupada".
- La configuración de conexión se guarda por balanza (local-bindings) y no en una sola clave por computadora.
- Antes de abrir el puerto se les pide a Mostrador y a las otras pestañas que lo suelten.
- Prueba: `multi-scale.test.ts`, Cuora simulada que contesta E3 a todo, con el caso real de Los gringos.

**Falta verificar con la balanza**
1. Que la versión corregida informe E3 (o silencio) con los bytes.
2. Leer la firma (modelo y protocolo) y compararla con la del 14/10 (protocolo 0060, max60, 103 productos, huella b8c2d441).
3. Pasar los productos y comprobar en la balanza que quedaron los precios (relectura automática + mirar 2 productos en el visor + 1 ticket escaneado en Mostrador).
