# Balanzas Kretz por cable: qué sabemos, cómo lo sabemos y cómo se descubre lo que falta

Última actualización: 2026-10-01 (primera Kretz Aura real de un cliente).

Objetivo: Patagonia OS → elegir el modelo → conectar → verificar → enviar **un** PLU de prueba → releerlo y comprobarlo → recién después habilitar el envío masivo. Sin iTegra.

Código:
- `apps/web/src/features/inventory/kretz/kretz-frame.ts`: trama Kretz (documentada), pura y testeada.
- `kretz/models.ts`: un perfil por modelo. Cada dato lleva su nivel de prueba y su fuente.
- `kretz/discovery.ts`: "Probar todo", **solo lectura**.
- `scale-serial.ts`: operaciones de la Report LT (comprobadas).
- `ScaleSyncPanel.tsx`: la pantalla.

## Regla de seguridad

- **Solo se escribe en la balanza si el protocolo de PLU de ese modelo está comprobado con una balanza real** (`canWritePlu`: `plu.evidence === "real"`). No alcanza con que esté documentado ni con una hipótesis. Hoy solo la Report LT cumple.
- "Probar todo" (`runKretzDiscovery`) **no puede** mandar comandos de escritura. `assertReadOnly` deja pasar solo:
  - 0001 / 0002: test de conexión.
  - 1500–1999: lectura de configuración.
  - 5000–5999: lectura de datos.
  
  Bloquea alta (2xxx), borrado (3xxx/4xxx) y configuración (0000–1499 salvo 0001/0002). Hay un test que revisa cada byte que sale.
- El envío masivo exige además una verificación previa con un PLU de prueba, hecha con la **misma** configuración (modelo, velocidad, bits de stop, letra, ID). Ese PLU de prueba se graba, se relee, se compara y se borra, y se usa solo si el código estaba libre.
- Riesgo residual, dicho con honestidad: con un protocolo desconocido no se puede garantizar al 100% que una trama de lectura Kretz no signifique otra cosa para la Aura. Lo minimizamos así: solo test y lecturas, tramas Kretz bien formadas, y una balanza que en otro formato las ignora. Peor caso esperado: un "bip" o ninguna respuesta.

## Niveles de prueba

| Nivel | Significa |
|---|---|
| **Real** | Probado con una balanza física, con resultado registrado. |
| **Documentado** | Lo dice un documento de Kretz (manual o guía). |
| **Terceros** | Lo dice otra empresa, no Kretz. |
| **Hipótesis** | Razonable, pero sin prueba. |
| **Desconocido** | No hay información. |

## Kretz Report LT / NX

| Dato | Nivel | Fuente |
|---|---|---|
| Trama: STX + tipo + ID(2) + comando(4) + datos + checksum(2) + EOT. Respuesta: 0x07 + tipo + ID + grupo(2) + código(2) + datos + checksum + EOT. | Documentado + Real | "Multiprotocolo para la comunicación con balanzas Report Nx" (Kretz) + Report LT de Carnes Patagonia |
| Checksum: suma de los bytes previos, byte bajo partido en nibbles, + 0x30. El ejemplo del documento ("67") y una respuesta real (`07 43 30 31 30 35 30 31 37 31 04`) cierran con ese cálculo. | Documentado + Real | `kretz-frame.test.ts` |
| 115200 baudios, 1 bit de stop, letra "C", ID "01". | Real | Report LT |
| 2005 alta/modificación, 3005 borrar, 5005 leer (devuelve el siguiente mayor), 5002 modelo de datos (entidad "05" = PLU). | Real | Report LT |
| Modelo de PLU real: 20 campos, 135 caracteres, precio de 6 dígitos (distinto del documento público). | Real | Report LT, comando 5002 |
| Tabla de códigos de respuesta. Antes usábamos otra tabla, corrida y sin fuente, y ya se corrigió. Solo "01" decide algo en el código. | Documentado; "01" Real | Documento Report Nx |

## Kretz Aura / Aura Eco

| Dato | Nivel | Fuente |
|---|---|---|
| RS-232, conector DB-9 **hembra** en la balanza. Pin 2 Tx, 3 Rx, 5 GND. | Documentado | Manual Aura Eco Rev.01 (04/03/2015), §16.1 |
| Cable **directo** 2-2, 3-3, 5-5: macho del lado de la balanza, hembra del lado de la PC. | Documentado | Manual §16.2 |
| Ojo: un diagrama "cable de conexión a la PC balanzas Kretz" que circula (fuente no oficial, sin modelo indicado) es **cruzado** (2↔3) y usa además el pin 6. Para la Aura no sirve. | Terceros | spegasoft.com, "Datos técnicos de Balanzas/Kretz" |
| 9600 baudios, 8 bits de datos, sin paridad, 2 bits de stop, ASCII. | Documentado | Manual §16.5 |
| Modos COMUNI: continua de peso, continua de peso-precio-importe, a pedido de peso, a pedido de peso-precio-importe, **Datos**. Puerto: RS-232. | Documentado | Manual §7.3, §16.3 |
| A pedido: se manda P/p/W/w y contesta `2,XX.XXX,CR` (en el otro modo agrega precio e importe). | Documentado; no probado en una Aura real | Manual §16.3.3, §16.4 |
| Modo **Datos**: "permite utilizar el Software iTegra ó el Driver de comunicación JDataGate" (el manual pone de ejemplo brillo y bajo consumo). **El protocolo no está publicado.** | Documentado | Manual §16.3.5 |
| Memoria de PLU 1–9999 (~797 libres en el ejemplo). Campos: nombre ≤16, código ≤6 dígitos, pesable sí/no, precio ≤6 dígitos, tara ≤4 dígitos (solo pesables), validez 0–250 días. | Documentado | Manual §8.2 |
| Número de balanza 1–99 (menú DATOS → n_bal). | Documentado | Manual §7.1.1 |
| Alta, baja y modificación de PLU, consulta de PLU, configuración y totales por **Bluetooth** con la app **iTegra Mobile**. La familia "PPI" incluye Aura, Novel Eco 2 y Delta Eco 2. | Documentado | "Guía rápida uso Bluetooth", Help Desk Kretz |
| Entonces, **existe** un protocolo de PLU para la Aura (al menos por Bluetooth). | Documentado | Ídem |
| "Drivers de iTegra compatibles con la Aura Eco" para cargar precios desde la PC. | Terceros | Centro de ayuda de Autogestiones |
| El manual de iTegra R005 (viejo) lista solo Report, Advanced y Plura. La versión 4.148 existe, pero no la revisamos: solo había un instalador en un sitio no oficial y no se bajó. | Documentado (versión vieja) | Manual iTegra R005 |
| El modo Datos usa la misma trama Kretz (STX…EOT) que la Report: la respuesta tiene la forma Kretz y el checksum da exacto. | **Real** | Primera Aura de un cliente, 2026-10-01: TX `0001` → RX `07 48 30 31 30 30 30 31 37 31 04` |
| Tipo de equipo **"H"**, ID "01", 9600 baudios, 2 bits de stop. El 0001 contesta código "01" (OK), grupo "00". | **Real** | Ídem |
| n_bal = ID de equipo del protocolo. | **Hipótesis** (consistente: contestó con ID 01 y el de fábrica es 1) | Falta probar con otro n_bal. |
| 1500 (datos técnicos): `AUI-030KMFBAPP4KAR  V1.00  6Feb24 00`. | **Real** | Reporte de soporte del cliente "Pollo y mar", 2026-10-01 |
| 0002 (test silencioso) y 5002 (modelo de datos) **no existen** en la Aura: contesta código "02". | **Real** | Ídem |
| 5005 lee un PLU: con el argumento `000000` devolvió el PLU 1, o sea "el siguiente mayor", igual que la Report. La respuesta viene con grupo "05", código "01" y un registro de **42 caracteres**: `000001FRUTILLA        P0000100010500000005`. | **Real** | Ídem |
| Checksum: cada nibble + 0x30, así que los valores 10–15 salen como `:`…`?` (por ejemplo `3c` = `<`). Las 5 respuestas reales cierran y la Aura aceptó nuestras tramas. | **Real** | Ídem |
| Reparto del registro (solo es una hipótesis): PLU 6 + nombre 16 + tipo 1 + código 6 + precio 6 + tara 4 + validez 3 = 42. Encaja con los límites del manual (§8.2). Ejemplo: FRUTILLA, tipo "P", código 000010, precio 001050 (¿1050 o 10,50?), tara 0000, validez 5 días. | **Hipótesis** | Falta comparar con la lista impresa (LISTAR → PRECI): orden código/precio, decimales y letras de tipo |
| Grabar y borrar PLU en la Aura: ¿2005 / 3005 con el mismo registro de 42 caracteres? | **Desconocido / hipótesis** | Se prueba solo con un PLU de prueba en un código libre, después de confirmar el reparto |
| Variante del cliente: DB-9, 30 kg, fabricada en Pueblo Esther (según la foto). Si tiene Bluetooth, no lo sabemos. | Real (foto) | Cliente, 2026-10-01 |

### Primera prueba real (2026-10-01): qué pasó y qué se corrigió

- El cliente probó desde Stock → "Balanza por cable" con la configuración de la Report LT (115200/1). Con esa velocidad la Aura no puede contestar. No dice nada del protocolo ni del cable.
- Errores nuestros encontrados y corregidos:
  - "Volver a elegir puerto" no abría el selector.
  - La detección automática daba por buena cualquier respuesta, aunque fuera ruido.
  - La lectura de peso podía colgarse si entraba ruido sin parar.

## Plan de descubrimiento (de menor a mayor riesgo)

### Paso A — "Probar todo", solo lectura (lo que hace el cliente mañana)

Con la balanza en COMUNI → MODO = Datos, "Probar todo" con el modelo "Kretz Aura / Aura Eco" y el número de balanza:

1. Escucha sin mandar nada y pide "W" a 9600/8N2. Sirve para saber si la balanza estaba en modo peso.
2. Prueba el test de conexión 0001:
   - En las 7 velocidades, con la letra más probable.
   - Con todas las letras A–Z en 9600/2 y 9600/1.
   - Con el ID = n_bal, y además "00".
3. Si alguien contesta con una respuesta Kretz válida, hace solo lecturas:
   - 0002 (test silencioso)
   - 1500 (datos técnicos)
   - 5002 "05" (largo de cada campo del PLU)
   - 5005 "000000" (primer PLU guardado)
4. Guarda cada byte que se mandó y que volvió (`DiagnosticRecord`). "Enviar a soporte" lo sube completo. Lo leemos desde "Reportes de balanzas" en la pantalla de administrador.

Segunda corrida, con MODO = "A pedido de peso": si contesta el peso, **el cable y el puerto están comprobados**. Así se separa "problema físico" de "protocolo distinto".

### Paso B — si la Aura contesta como Kretz

1. Analizamos el registro: letra, ID, modelo de campos (5002) y un PLU real leído (5005).
2. Escribimos el driver de la Aura en `models.ts` y en las funciones de PLU, con su modelo de campos. La documentación del manual sirve para validar los anchos.
3. Primera escritura, con nuestra guía y la conformidad del cliente:
   - El "PLU de prueba" va en un código **libre** (se lee antes, y si existe no se toca).
   - Se escribe, se relee, se compara campo por campo y se borra.
4. Solo si eso da exacto: `plu.evidence = "real"` para la Aura. Eso habilita "Enviar uno". Después del paso 3 de la pantalla se habilita "Enviar todos".

### Plan C — si en modo Datos no contesta nada Kretz (pero en modo peso sí)

El cable anda y el protocolo es otro. Opciones, en orden:

1. **Pedírselo a Kretz.** Publican el de la Report NX, así que lo razonable es pedir el de la familia PPI/Aura (borrador abajo).
2. **Registrar el tráfico de la herramienta oficial**, mirando solo nuestro propio equipo y sin abrir programas de Kretz por dentro:
   - **Por Bluetooth**, si la Aura lo tiene. En un Android, activar "Registro de búsqueda de HCI Bluetooth" (Opciones de desarrollador). Después, con iTegra Mobile: primero "Consulta de PLU" (lectura) y después el alta de **un** PLU de prueba en un código libre. Generar el informe de errores y mandarnos el archivo `btsnoop_hci.log`. Ahí están los bytes exactos de cada comando.
   - **Por cable**, si en esa PC anda iTegra/JDataGate con la Aura. Un monitor de puerto serie registra lo que iTegra manda en una consulta y en el alta de un PLU de prueba.
   - En los dos casos: primero una operación de lectura, después una sola escritura de prueba, nunca un "transmitir todo".
3. Con el tráfico capturado: identificar trama, checksum, comandos y respuestas. Volver al Paso B con el driver nuevo, siempre empezando por las lecturas.

No hacemos: decompilar iTegra/JDataGate ni la app (por licencia), ni probar comandos de escritura "a ver qué pasa".

## Borrador de mail para Kretz (soporte técnico / integraciones)

> Asunto: Protocolo de comunicación de PLU para balanzas Aura / Aura Eco 2 (familia PPI)
>
> Hola. Somos Patagonia OS, un sistema de gestión para carnicerías usado por clientes que tienen balanzas Kretz. Ya integramos la Report LT con el documento "Multiprotocolo para la comunicación con balanzas Report Nx" (comandos 2005/3005/5005), y funciona.
>
> Tenemos clientes con Aura Eco / Aura Eco 2 que quieren cargar productos y precios desde nuestro sistema. Según el manual, en COMUNI → Datos la Aura trabaja con iTegra / JDataGate, y según la Guía Bluetooth admite ABM de PLU desde iTegra Mobile.
>
> ¿Nos podrían facilitar el documento de protocolo de comunicación para la familia PPI (Aura / Novel Eco 2 / Delta Eco 2)? En particular: parámetros serie, formato de trama, letra de tipo de equipo, comandos de alta/lectura/borrado de PLU, modelo de datos del PLU y códigos de respuesta. Si existe un SDK, una versión de JDataGate para integradores o un programa de integradores, también nos interesa.
>
> Muchas gracias.

## Qué le pedimos al cliente (resumen)

Está en la guía para el cliente: `docs/AURA_PRUEBA_CLIENTE.html` (y su PDF).

## Incidente: "Failed to open serial port" (Aura de la clienta, 2026-10-01/02)

Registro real (`scale_support_reports`, con el error exacto de cada apertura desde la versión 2026-10-01e):

- **2026-10-01 10:06 (hora AR): todo anduvo.** Abrió el puerto, la Aura contestó 0001, 0002, 1500, 5002 y 5005. Protocolo compatible: **real**.
- **Desde las 11:07: Windows rechaza abrir el puerto** con `NetworkError: Failed to open serial port`.
  - Algunas corridas abrían en 115200 y 4800, y una vez en 9600 justo después de 4800.
  - El 2026-10-02 hubo 2 corridas con 700 intentos cada una y ninguna apertura, aun recargando la página.
- **El mismo error ya figuraba el 30/9 a la mañana** en el registro de esa PC, con la configuración de la Report. O sea, es anterior a todo el trabajo de la Aura.
- **Conclusión:** la falla está en la etapa "abrir la conexión", en la PC, antes de la balanza.
  - En Windows un puerto serie lo abre UN solo proceso a la vez.
  - Patagonia deja el puerto abierto después de usarlo: `scale-weight.ts` no lo cierra tras leer el peso, y el `ensureOpen` de `scale-serial.ts` tampoco.
  - Una pestaña o ventana de Chrome (incluso de otro perfil) o un programa externo que lo tenga tomado produce exactamente este error.
  - La clienta usa al menos dos perfiles de Chrome (se ven en su barra de tareas).

**Corregido en código:**

- `serial-tabs.ts`: cada pestaña de Patagonia del mismo Chrome y perfil responde por BroadcastChannel. "Probar todo" les pide soltar los puertos que tengan abiertos y no estén en uso, y anota cuáles los tenían.
- `runKretzDiscovery` por etapas (dispositivo → abrir → enviar → recibir → interpretar):
  - Si no abre en ninguna velocidad, corta enseguida con veredicto `puerto` y lo explica, en vez de barrer cientos de combinaciones.
  - Prueba primero la combinación ya comprobada ("H", 9600/2).
- La Report LT queda igual. El paso de verificación previa al envío masivo es solo para modelos que no son la Report LT.

**No verificable desde el código:** qué proceso tiene tomado el puerto, si es otro perfil de Chrome o un programa. BroadcastChannel no llega a otros perfiles ni a otros programas.

### Segunda revisión (2026-10-02, versión de prueba `2026-10-02b`)

**Los 700 intentos los generó nuestra propia prueba.** No hubo un bucle de reconexión de fondo. Cada corrida de "Probar todo" reintentaba así:

- 4 intentos por velocidad.
- Una ronda de "destrabar" (abrir en 4800/115200) después de CADA falla.
- Un barrido de unas 58 combinaciones.

Los horarios de los 700 caen todos entre el inicio y el fin de cada corrida. No hay ningún código que reabra la balanza solo: la reconexión automática de la pantalla Balanzas solo corre si esa pantalla oculta está abierta. Las aperturas que fallan no dejan el puerto tomado.

**Qué se corrigió:**

- `kretz/port-session.ts` es el único camino de apertura de "Probar todo" y de la lectura de productos.
  - **Presupuesto:** como mucho 12 aperturas por prueba y 4 por lectura.
  - **Reintentos:** 2 intentos por velocidad.
  - **"Destrabar":** UNA sola vez por prueba.
  - **Una prueba por puerto a la vez:** la segunda se rechaza sin tocar el puerto.
  - **Puerto reconectado:** si el adaptador se desenchufó y volvió, se toma el puerto nuevo (por USB vendor:product).
  - **Error clasificado:** `InvalidStateError` = abierto en esta pestaña (se cierra y se abre). `NetworkError` = Windows lo rechazó. `NotFoundError` o `connected=false` = desconectado, y no se reintenta. `SecurityError` = sin permiso.
- `sale/scale-weight.ts` (peso en Mostrador, Aura) cierra el puerto a los 10 s sin uso. Antes lo dejaba abierto todo el día, y eso bloqueaba a cualquier otra pestaña o programa.
- La Report LT (`scale-serial.ts`: `ensureOpen` y el envío) NO se tocó.

**Evidencia sobre Windows y el adaptador (de los registros reales):**

- **10-01 a las 16:13:** el mismo puerto abrió en 115200 y en 4800 pero NO en 9600, y abrió en 9600 justo después de 4800. Un bloqueo de otro proceso no depende de la velocidad, así que en ese momento el problema era el adaptador o su driver (chip CH340) rechazando la configuración.
- **10-02:** no abrió en NINGUNA velocidad, ni recargando la página, y el estado previo era siempre "cerrado" en nuestra pestaña. Eso encaja con otro proceso que lo tiene tomado (otra ventana o perfil de Chrome, o un programa) o con un adaptador o driver trabado.
- Web Serial no da el código de Windows. El detalle queda en `chrome://device-log` de esa PC.
- Desenchufar y volver a enchufar el USB reinicia el driver y suelta cualquier proceso que lo tenga, así que resuelve los dos casos.

### Resultado real con la versión `2026-10-02c` (2026-10-02 11:23 AR)

**Anduvo todo.** Etapas dispositivo → abrir → enviar → recibir → interpretar, todas en verde. La balanza contestó como equipo H01 a 9600 baudios con 2 bits de stop, y se leyeron los 6 PLU de la balanza hasta el final ("no hay registros"). Hubo 3 aperturas en la prueba y 3 en la lectura.

**Patrón del adaptador CH340 (real, se repitió 2 de 2 veces):**

1. La primera apertura en 9600 con 2 bits de stop falla: `NetworkError`.
2. Ninguna pestaña tenía el puerto ("readable=no", y la otra pestaña tenía 0 puertos abiertos).
3. La apertura en 4800 con 1 bit de stop ("destrabar") anda al instante.
4. La siguiente apertura en 9600 con 2 bits de stop anda.

Conclusión: no es otro proceso que lo retiene, es el adaptador o su driver. **Cualquier función futura que abra la Aura (por ejemplo, la escritura de PLU) tiene que usar `openForSession`**, que ya hace ese "destrabar".

**Los 6 registros reales (42 caracteres cada uno):**

```
000001FRUTILLA        P0000100010500000005
000002PASTELITOS      N0000200000900000003
000003PAN NEGRO       P0000300004800100001
000006MILA BERENJENA  D0000600052000000000
000008PROMO           C0000800189000000000
000011HAMB POLLO      D0001100108000000000
```

- **Real:** PLU (6), nombre (16) y una letra (P/N/D/C).
- **Real:** los 5 dígitos siguientes repiten el número de PLU (probable código de artículo).
- **Hipótesis:** el precio está en los dígitos siguientes (001050, 000090, 000048, 000520, 001890, 001080, o con un dígito más). Falta compararlo con el precio que muestra la balanza para un producto.

### Primera escritura real en la Aura (2026-10-02 12:02 AR, PLU 99, versión `2026-10-02d`)

**Lo que se mandó y lo que quedó guardado:**

- Mandado: `000099PRUEBA PATAGONIAP0009900012340000000`, con el comando 2005. La balanza contestó código 01.
- Releído: `000099PRUEBA PATAGONIAD0000000012340000000`.

**Lo que quedó comprobado (real):**

- **2005 con el registro de 42 caracteres escribe.** Los 6 productos de la clienta quedaron idénticos: se leyó la lista antes y después.
- **Precio en pesos enteros, sin decimales.** Se mandó 001234 y la pantalla mostró "1234 $/kg" (foto de la clienta). Entonces FRUTILLA, guardada como 001050, figura en la balanza a $1.050/kg.
- Nombre, precio, tara y validez se guardaron tal cual se mandaron.

**Lo que NO se guardó como se mandó:**

- La letra: se mandó "P" y quedó "D".
- El código: se mandó 000990 y quedó 000000.

La balanza los reemplazó y igual contestó 01. Qué significan la letra (P/N/D/C) y el código, y por qué los cambió, sigue **desconocido**.

Además, el código probablemente va en el código de barras del ticket que lee Mostrador. Hay que resolver esto antes del envío masivo.

### Análisis sin Kretz (2026-10-02, tarde)

**Documentación pública revisada:**

- El enlace `kretz.com.ar/shop/balanza-aura-eco-332/document/229` ("protocolo Aura") **no es público**: redirige a la tienda, también desde un navegador.
- La página de la Aura publica cuatro documentos, y ninguno es el protocolo:
  - 11: manual de usuario;
  - 114: folleto;
  - 115: ficha técnica;
  - 228: guía rápida.

**Comprobado con las tramas reales** (`kretz/aura-real-frames.test.ts`):

- Las respuestas a 5005 tienen checksum correcto.
- Los 6 productos se separan y se vuelven a armar idénticos.
- La trama 2005 que salió es exactamente la que arma el código.
- Las únicas diferencias entre lo mandado y lo guardado son la posición 22 (siempre "D") y las 23-28 (siempre "000000").

**Código de barras de los tickets** (`2099998000008`, el mismo en los dos tickets):

- Es EAN-13 válido.
- Leído con el formato 2-5-5 del manual (§7.1.7): inicio "20", código "99998" (probable código suma de ticket), valor "00000".
- No trae producto ni importe.

**Hipótesis no comprobada sobre la escritura:** el formato de escritura podría ir en el orden de la Report NX: código (5) y después tipo (1). En ese caso, lo que mandamos en esas posiciones sería inválido, y la balanza pondría los valores por defecto (D y 0).

- A favor: explica las 5 escrituras.
- En contra: no es simétrico con la lectura.
- No se prueba sin autorización ni protocolo.
