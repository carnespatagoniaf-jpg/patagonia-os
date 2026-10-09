# Diagnóstico Systel Cuora Max: Los gringos (2026-10-09)

Fuentes: los reportes automáticos a soporte (`scale_support_reports`, prod, empresa `a2660765…`), con cada byte enviado y recibido. Los documentos oficiales usados son el Protocolo Cuora Max V6.0 Rev 06 (el que corresponde, ver 1.2), V6.2, V7.0 y el programa de ejemplo VB de Systel, todos del zip oficial. También el Manual de Instalación de la Cuora Max.

Etiquetas: **COMPROBADO** (bytes reales), **DOCUMENTADO** (lo dice Systel), **HIPÓTESIS** (falta comprobar).

## 1. Qué sabemos con certeza (COMPROBADO)

1. **Conexión.** Cable USB, chip FTDI 0403:6001, 115200 baudios, 8 bits, sin paridad, 1 bit de stop. Identificación **20**: a las 16:08 contestó con el número 20 al ping general (0). El ejemplo del manual oficial también muestra "Id : 20".
2. **Firma (función 2):** `F2000C030000S0060P08000A060D0`. Quiere decir protocolo **0060**, 8.000 PLU y precio **sin decimales**. Corresponde al documento **V6.0**: PLU de 4 dígitos, lectura con la 62 y escritura con la 61. La configuración (39) dice `CPr=0` (coma de precio en 0) y `Sinc=0` (no espera sincronización al encender).
3. **Ping (23):** `00D`, trabajando desactualizado. No está bloqueada esperando sincronización, que sería la letra `S`.
4. **Lista (31):** llegaron 982 bytes. Son 140 PLU completos: 1-128, 200, 201, 400-405 y 500-503, de los cuales 31 cargados desde una PC (versión 1). El corte cae justo al final de un PLU, **sin la "F" final ni el byte de verificación**, que el documento exige (V6.0, función 31).
5. **E3 (16:26, 16:40 y 16:41):** 30 pedidos en total, todos contestados con `E3` en tramas bien formadas y con la verificación correcta. Esas órdenes (`14 17 03` ping, `14 02 16` firma) son **byte por byte las mismas** que a las 16:08 tuvieron respuesta normal.

## 2. Fallas encontradas

### 2.1 Lista cortada: CAUSA COMPROBADA, CORREGIDA
- **Evidencia:** punto 1.4. Patagonia daba la respuesta por terminada tras 60 ms de silencio, y la balanza hace una pausa antes de la "F". Lo más probable es que recorra los 8.000 lugares de memoria después del último PLU, pero eso no está comprobado.
- **Efecto:** a las 16:08 el respaldo se frenó con "no se pudo leer la lista de productos". No se escribió nada.
- **Corrección:** si lo recibido todavía no es una trama completa con su verificación, se sigue esperando hasta el plazo de la orden (15 s para la lista). La respuesta también se busca aunque delante haya quedado el final de una respuesta anterior (`findSystelReply`).
- **Prueba:** con los 982 bytes reales más la "F" y la verificación (DOCUMENTADO, no capturado), enviados después de una pausa de 1,5 s, Patagonia lee los 140 PLU. Sin la "F" no la acepta.

### 2.2 E3 a todo: CAUSA NO COMPROBADA
- **Descartado con evidencia:** que el contenido de nuestras órdenes cause el E3. Son idénticas a las que funcionaron. La balanza las entendió, porque contesta con su número, la función correcta y la verificación bien.
- **Descartado con evidencia:** que esté bloqueada esperando sincronización. `Sinc=0` y el ping dio `D`.
- **Lo que dice Systel:** solo "E3 = Se desatendieron datos", en los tres protocolos. No dice cuándo ocurre ni cómo se limpia, y el manual tampoco.
- **HIPÓTESIS A (secuencia de arranque):** en la única sesión que anduvo, la primera orden fue a otro número (1, sin respuesta) y la segunda al general (0); recién después se le habló a su número. En las 3 sesiones con E3 se le habló directo al 20 apenas se abrió el puerto: así lo hizo el arreglo que publiqué, al recordar el número 20. **Corrección (sin riesgo, solo pings de lectura):** se repite exactamente la secuencia que anduvo (1 → 0 → 20) al conectar, y antes de cada reintento por E3.
- **HIPÓTESIS B (estado de la balanza):** que desde las 16:26 la balanza esté en un menú o en una operación. No hay evidencia a favor ni en contra. Si es esto, la corrección A no alcanza.
- **HIPÓTESIS C (lista sin terminar):** que la lectura de la lista de las 16:08, cortada de nuestro lado, haya dejado a la balanza esperando. Solo hay coincidencia en el tiempo: fue la primera vez que le pedimos la 31. La corrección 2.1 evita que vuelva a pasar.
- **Límite:** si después de la secuencia sigue el E3, Patagonia no insiste más de 5 veces, manda solo pings y firma, y no escribe nada.

### 2.3 Precio con centavos en una balanza sin decimales: CORREGIDO
- Antes, $4.599,50 se redondeaba en silencio a $4.600 y el ticket cobraba distinto que Patagonia. Ahora no se manda y se avisa el motivo. Prueba agregada.

### 2.4 Reportes a soporte: LÍMITE A TENER EN CUENTA
- El servidor acepta **20 reportes por empresa cada 24 h**, y hoy Los gringos usó 12. Cada toque del botón manda **un** reporte.

## 3. Revisión contra el documento V6.0 (sin cambios necesarios)
- **Trama** dirección + función + ASCII + XOR: igual que el documento y el ejemplo VB. Verificado con las 6 respuestas reales.
- **Lectura 62:** PLU 4, gestión 1, nombre 18, 2 precios de 6, código 5, sector 2, vencimiento 4, tipo 1, tara 4, resto 105 (+100 si tiene ingredientes). El código coincide campo por campo.
- **Escritura 61:** igual que la 62 pero sin "gestión". El documento la muestra **sin** byte de verificación y el ejemplo VB con verificación (función 4). Se manda con verificación y, si contesta E5, sin. Ver consulta.
- **Cambio de precio 33:** PLU 4 + "versión" 1 letra + lista 1 + lista 2. Se manda "1" (gestionado desde PC, mismo significado que en la lista). Hay que confirmarlo con Systel.
- **Precio:** 6 números sin coma; con D0, pesos enteros.
- Patagonia **nunca manda** las funciones 5, 9, 26, 32, 42 ni ninguna de configuración (lista blanca con prueba).

## 4. Pruebas (`npm run test`: 386 pasan)
- `systel-real.test.ts`: bytes REALES (huella md5 igual a la de la base de datos) de firma, ping, configuración, lista y E3, y una sesión reproducida con esos bytes.
- La sesión reproducida no tiene respuesta para la función 62, porque nunca la capturamos. El respaldo se frena en "no se reconoció el formato" y no inventa nada.
- La prueba de la hipótesis A falla con el código anterior y pasa con el nuevo. Comprueba lo que hace Patagonia, no que la balanza se comporte así.
- También hay pruebas de desconexión del cable (reabre una vez), respuesta en dos partes, E3 permanente (pocas órdenes, solo lectura), precio con centavos, y las anteriores de diferencias al releer (frena).

## 5. Lo que NO se puede comprobar desde acá
1. La causa del E3 y si la secuencia 1 → 0 → 20 lo evita.
2. El formato real de la respuesta de la función 62 en esta balanza (nunca llegamos a leer un producto).
3. Cuánto tarda la "F" de la lista. Esperamos hasta 15 s.
4. Si la 33 acepta "1" como versión, y si la 61 lleva verificación.

## 6. Consulta técnica para Systel

> Asunto: Protocolo Cuora Max V6.0 (firma S0060): consulta por error E3
>
> Integramos la Cuora Max por USB (FTDI, 115200 8N1) según el "Protocolo de comunicación CUORA MAX V6.0 Rev 06". Una balanza con firma F2000C030000S0060P08000A060D0 e identificación 20 respondió bien a las funciones 2, 23, 39 y 31. 18 minutos después respondió `E3` (trama 14 17 45 33 75) a todas las órdenes, incluso al ping `14 17 03`, que antes contestaba `00D`.
> 1. ¿En qué situaciones devuelve E3 "Se desatendieron datos"? ¿Es por estar en un menú, con un ticket abierto o imprimiendo, por un error de recepción, o por una respuesta anterior que la PC no terminó de leer?
> 2. ¿Cómo se sale de ese estado sin apagar la balanza? ¿Hay alguna orden o algún tiempo de espera?
> 3. Función 31: ¿puede haber una pausa antes de la "F" final? ¿Cuánto puede durar como máximo?
> 4. Función 61 (V6.0): el documento indica "IP + Función + Datos" sin verificación, y el programa de ejemplo la agrega en la función 4. ¿Lleva o no el byte XOR?
> 5. Función 33: ¿qué valores acepta el campo "Versión del PLU"? ¿"1" (gestionado por PC) es correcto?
> 6. ¿Hay una versión del protocolo más nueva para firmware 0060?

## 7. Única prueba mínima con la balanza (después de publicar esto)
Una sola acción del cliente: con la balanza encendida, tocar **"Mandar productos a la balanza"** una vez.
- **Qué hace:** la secuencia 1 → 0 → 20, después firma, ping, configuración, la lista completa y la lectura de cada PLU con la 62. Todo eso es solo lectura. Después manda únicamente los productos con precio en Patagonia que coinciden con la balanza (hoy 3), y relee cada uno.
- **Qué nos llega:** un único reporte con todos los bytes.
- **Qué decide:**
  - si la secuencia evita el E3 (hipótesis A);
  - el formato real de la 62;
  - el tiempo de la "F" de la lista;
  - si se acepta la 33.
- **Si vuelve a dar E3:** la hipótesis A queda descartada, la respuesta depende de Systel (consulta 6), y no se le pide nada más al cliente.
