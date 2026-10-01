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
| El modo Datos usa la misma trama Kretz (STX…EOT) que la Report. | **Hipótesis** | Familia Kretz. Se confirma si la Aura contesta un 0001 con una respuesta 0x07…EOT válida. |
| n_bal = ID de equipo del protocolo. | **Hipótesis** | Así es en la Report ("número de equipo"). |
| Letra de tipo de equipo, comandos de PLU, formato de campos, ACK/errores de la Aura. | **Desconocido** | Se averigua con "Probar todo" (solo lectura), o con los planes B/C de más abajo. |
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
