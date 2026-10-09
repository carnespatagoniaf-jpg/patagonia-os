# Diagnóstico Systel Cuora Max: Los gringos (2026-10-09, revisión 2)

**Estado:** el envío de precios está BLOQUEADO en el código (`SystelClient.allowWrites`, por defecto `false`, con prueba). El botón del piloto solo lee. No se le pide nada al cliente.

**Fuentes:**
- Los reportes automáticos a soporte (`scale_support_reports`, prod, empresa `a2660765…`), con cada byte.
- Los documentos oficiales: Protocolo Cuora Max V6.0 Rev 06 (el que corresponde a esta balanza), V6.2, V7.0 y el programa de ejemplo VB de Systel, todos del zip oficial. También el Manual de Instalación de la Cuora Max.

**Etiquetas:**
- **COMPROBADO:** sale de bytes reales.
- **DOCUMENTADO:** lo dice Systel.
- **HIPÓTESIS:** falta comprobar.
- **NO REGISTRADO:** no lo guardábamos, así que no se puede saber.

## 1. Comparación de las conexiones

`ms` = desde que Patagonia manda hasta que da la respuesta por terminada. Incluye los 60 ms de silencio que el código espera y hasta 10 ms de sondeo. La demora real de la balanza es aproximadamente `ms − 60 a 70`.

| | 16:08 (anduvo) | 16:26 | 16:40 | 16:41 |
|---|---|---|---|---|
| Código | búsqueda automática, sin número guardado | igual que 16:08, con el número 20 guardado | + reintentos por E3 + lista hasta la F | misma conexión abierta que 16:40 |
| Puerto | elegido en Chrome | elegido de nuevo (página nueva) | elegido de nuevo | el mismo objeto de 16:40 |
| Velocidad / formato | 115200 8N1 | igual | igual | igual |
| DTR/RTS | encendidas (código) | igual | igual | igual |
| 1.ª orden después de abrir | `01 17 16` (ping al 1): sin respuesta, 356 ms | `14 17 03` (ping al 20): **E3** | `14 17 03`: **E3** | `14 02 16` (firma): **E3** |
| 1.ª orden al 20 | ~450 ms después de abrir, tras el ping al 1 y el general | apenas abierto | apenas abierto | conexión abierta hace ~29 s |
| Respuestas | `00 17 17` → 89 ms; firma 81; ping 78; configuración 113; lista 187 (982 bytes) | 96, 86, 79 ms | 71 a 93 ms (18 órdenes) | 71 a 91 ms (12 órdenes) |
| Forma de la respuesta | completas con verificación bien, salvo la lista (sin F ni verificación) | 5 bytes `14 fn 45 33 xx`, verificación bien | igual | igual |
| Bytes descartados antes de mandar | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO |
| Cierre de la página / puerto | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO |

**Lo que muestra la tabla (COMPROBADO):**
1. La balanza contestó igual de rápido en las conexiones buenas y en las de E3 (unos 10 a 35 ms). No hay señal de que estuviera "procesando" otra cosa más lenta.
2. Las respuestas E3 vinieron completas, con su número (20), la función que pedimos y la verificación bien, y sin bytes de más dentro de la respuesta. Nuestra forma de cortar las respuestas (60 ms de silencio) fue la misma en todas.
3. El E3 se repitió durante unos 10 s de reintentos (16:40) y 29 s después **sobre la misma conexión abierta** (16:41). No fue algo pasajero apenas abierto el puerto.

**Diferencias de NUESTRO lado entre la que anduvo y las E3:**
- **D1. Secuencia y tiempo hasta la primera orden al 20.** En la buena, antes de hablarle al 20 hubo una orden a otro número y una general, y ~450 ms de puerto abierto. En las E3 se le habló al 20 apenas abierto el puerto. Este cambio lo introdujo nuestro código, al recordar el número 20.
- **D2. Lo que quedó pendiente de la sesión anterior.** La última vez que la balanza habló con nosotros antes del E3 fue la lista de las 16:08, que cortamos. No sabemos si llegaron más bytes ni si la página se cerró mientras la balanza transmitía. Además, el código **tiraba sin anotar** cualquier byte que hubiera en el buffer antes de cada orden.
- **D3. Qué puerto se eligió.** No guardábamos el USB elegido ni cuántos puertos había. Que contestara un aparato Systel con número 20 hace probable que sea la misma balanza, pero **no se puede descartar** que fuera otro equipo o puerto.

**No hay evidencia** de diferencias en la velocidad, el formato de las órdenes, los bytes enviados ni la forma de leer las respuestas.

## 2. La lista de productos (función 31)

- **COMPROBADO (falla nuestra):** lo que guardamos son 982 bytes: 140 PLU completos y sin la "F" ni la verificación. El código daba la respuesta por terminada tras 60 ms de silencio.
- **NO COMPROBADO:** que la balanza haya mandado la "F" y la verificación después. Los bytes posteriores se tiraban sin anotar. La prueba que agrega un cierre "de mentira" demuestra que **el código** ahora espera; **no confirma** que la balanza lo mande ni cuánto tarda.
- **Corrección:**
  - Espera hasta 15 s a que la trama cierre con su verificación.
  - Busca la respuesta aunque delante haya restos de otra.
  - **Ahora anota** todo byte descartado, con su contenido y su momento. Una prueba lo demuestra: con el comportamiento de las 16:08, el cierre que llega tarde queda registrado.

## 3. E3: causa NO COMPROBADA

- **Descartado (COMPROBADO):** que esté bloqueada esperando sincronización, porque `Sinc=0` y el ping dio `D`. También que el contenido de las órdenes sea inválido: son las mismas que funcionaron, y la balanza contestó con la función correcta.
- **DOCUMENTADO:** solo "E3 = Se desatendieron datos". No dice cuándo pasa ni cómo se sale.
- **Hipótesis:**
  - **H1 (D1).** Hablarle a su número apenas abierto el puerto, sin la secuencia previa, la deja en error. Se corrigió repitiendo la secuencia comprobada (1 → 0 → número) solo con pings. Pero D5 hace dudar: el E3 siguió 29 s después sobre la misma conexión, así que habría que suponer un error que queda fijo.
  - **H2 (D2).** La lista cortada de las 16:08 dejó a la balanza en un estado pendiente. Solo hay coincidencia en el tiempo.
  - **H3 (D3).** Era otro puerto u otro equipo.
  - **H4.** Algo en la balanza (un menú, una operación). No hay evidencia ni a favor ni en contra.
- Ninguna se puede confirmar con los datos que tenemos. Las hipótesis H2 y H3 ahora quedarían registradas (bytes descartados, USB elegido y cantidad de puertos).

## 4. Registro nuevo del cable (para no depender de suposiciones)

`SerialSystelLink.events` va en cada reporte (`diagnosticRecord.linkEvents`). Registra:
- apertura (velocidad y USB vendedor:producto) y errores al abrir;
- señales DTR/RTS;
- cada orden, con sus bytes y su momento;
- cada respuesta: cantidad de bytes, a los cuántos ms llegó el primero y el último, pausas y cómo terminó (silencio / incompleta / plazo);
- bytes descartados (llegados sin pedir o al cerrar), con su contenido;
- corte de lectura y cierre.

El reporte también incluye cuántos puertos tiene autorizados Chrome y cuál se eligió.

## 5. Revisión contra el documento V6.0

- **Trama:** dirección + función + ASCII + XOR. Verificada con las 6 respuestas reales.
- **Lectura 62:** el código respeta el documento campo por campo. NUNCA se leyó un producto real.
- **Escritura 61:** el documento la muestra sin XOR y el ejemplo VB la manda con XOR (en la función 4). Va en la consulta.
- **Cambio de precio 33:** el campo "versión" no tiene valores documentados. Va en la consulta.
- **Precio:** con D0 son pesos enteros. Un precio con centavos ya no se redondea: no se manda.
- **Funciones prohibidas** (5, 9, 26, 32, 42 y las de configuración): bloqueadas por una lista blanca, con prueba.

## 6. Pruebas (`npm run test`: 388 pasan)

- **Con bytes REALES** (huella md5 igual a la de la base): firma, ping, configuración, lista cortada y E3.
- **Sesión reproducida:** sin captura de la función 62, el respaldo frena sin inventar.
- **Envío bloqueado por defecto:** no sale ninguna función de escritura.
- **Registro del cable:** anota la apertura, los tiempos y los bytes tardíos.
- **Casos de borde:** desconexión del cable, E3 permanente (pocas órdenes, solo lectura), precio con centavos y diferencias al releer.
- Las pruebas que usan cierres o un E3 "modelado" están marcadas: prueban **nuestro código**, no a la balanza.

## 7. Lo que necesita una balanza física

1. **Lectura completa:** que la lista llegue con su F y su verificación (y cuánto tarda), y el formato real de la función 62 en firmware 0060, comparado con lo que muestra la pantalla.
2. **E3:** qué lo provoca y cómo se sale. Reproducirlo con cada hipótesis:
   - hablar apenas abierto el puerto;
   - cerrar la página a mitad de una lista;
   - estar en un menú o con un ticket abierto.
3. **Escritura (solo en una balanza de prueba):** la 33 sobre un PLU de prueba, la 61 en un número libre (con y sin XOR), y releer.

**Cómo conseguirla sin el cliente** (de más a menos recomendable):
- **a)** Un agente técnico autorizado Systel (ATAS) o un distribuidor que tenga una Cuora Max con firmware 0060 en mostrador. Nos prestan una hora de banco. Yo manejo la prueba con una compu ahí o por AnyDesk. Si además tienen Qendra, el software oficial de Systel, se puede **grabar con un monitor de puerto serie** cómo Qendra lee y escribe: eso es la verdad del fabricante para la 62, la 33 y la 61.
- **b)** Soporte técnico de Systel: la consulta de abajo, con el pedido de que reproduzcan el E3 en su laboratorio.
- **c)** Comprar o alquilar una Cuora Max usada para tenerla en la oficina. Es decisión del dueño, y el costo hay que averiguarlo.

**Para dar algo por aprobado:**
- lista completa con F y verificación en 3 lecturas seguidas;
- 62 coincide con la pantalla en 3 productos (nombre, precio, código, tipo);
- E3 reproducido y con una forma de salir confirmada;
- 33 y 61 releídas idénticas en la balanza de prueba.

Recién ahí `allowWrites` puede pasar a `true`, y solo para esa versión de firmware.

## 8. Consulta para Systel (texto final)

Está en el mensaje al dueño del 2026-10-09 y se repite acá:

> **Asunto:** Integración Cuora Max por USB (protocolo V6.0, firma S0060): error E3 y dudas de formato
>
> Hola. Somos Patagonia OS, un sistema de gestión para carnicerías. Integramos la Cuora Max por USB (FTDI, 115200 baudios, 8N1) según el "Protocolo de comunicación CUORA MAX V6.0 Rev 06" de su sitio. Por ahora solo leemos. Tenemos estas dudas sobre una balanza de un cliente:
>
> **Equipo:** firma `F2000C030000S0060P08000A060D0`, identificación 20, configuración `Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;…;Sinc=0;…;PeP=3;SEt=S;ETi=N`.
>
> **Qué pasó (bytes en hexadecimal, PC → balanza / balanza → PC):**
> - 16:08: `00 17 17` → `14 17 30 30 44 47` ("00D"). `14 02 16` → firma completa. `14 17 03` → `14 17 30 30 44 47`. `14 27 33` → configuración completa. `14 1f 0b` → recibimos 982 bytes ("N0001V0…N0503V0", 140 PLU) y nuestro programa dejó de leer tras 60 ms de silencio, sin llegar a la "F".
> - Desde las 16:26 (en otras conexiones), las mismas órdenes respondieron siempre `14 17 45 33 75` y `14 02 45 33 60` (E3), durante 30 intentos en 15 minutos, incluso sobre una misma conexión abierta.
>
> **Preguntas:**
> 1. ¿En qué situaciones devuelve E3 "Se desatendieron datos"? Por ejemplo: menú abierto, ticket abierto, impresión, error de recepción, o una respuesta anterior que la PC no terminó de leer.
> 2. ¿Cómo se sale de ese estado sin apagar la balanza? ¿Hay una orden, una secuencia o un tiempo de espera?
> 3. ¿La balanza necesita algo al abrir el puerto (tiempo de espera, señales DTR/RTS) antes de la primera orden?
> 4. Función 31: ¿la balanza hace una pausa antes de la "F" final? ¿Cuánto puede durar como máximo? Si la PC deja de leer a mitad, ¿qué estado queda?
> 5. Función 61 (V6.0): el documento indica "IP + Función + Datos" sin verificación, y el programa de ejemplo la agrega en la función 4. ¿La 61 lleva el byte XOR al final?
> 6. Función 33: ¿qué valores acepta el campo "Versión del PLU"? ¿Es correcto "1" (gestionado desde PC)?
> 7. ¿Hay un documento de protocolo más nuevo para el firmware 0060, o un registro de cambios?
> 8. ¿Tienen un agente técnico (ATAS) en nuestra zona con una Cuora Max de prueba, para validar la integración en banco sin usar la balanza de un cliente?
>
> Podemos mandar el registro completo de bytes. Gracias.
