# Diagnóstico Systel Cuora Max: Los gringos (revisión 3, 2026-10-09)

**Estado:**
- El envío de precios y productos está **BLOQUEADO** en el código (`SystelClient.allowWrites = false` por defecto, con prueba).
- El botón del piloto solo lee.
- Los cambios de esta revisión **no están publicados** (falta autorización del dueño).
- No se contactó a Systel ni se le pidió nada al cliente.

## 1. Documentación revisada

Fuente: `soporte.systel-global.com/instructivos/`, descargada el 2026-10-09. El zip del protocolo es idéntico al bajado el 2026-10-04 (SHA-256 `e33cf997…cf1ee`).

| Archivo | Qué es |
|---|---|
| `Protocolo de comunicaciones CUORA 2 V4.0 Rev 00.pdf` | Rev 03/Dic/2010 |
| `Protocolo de comunicaciones CUORA MAX V6.0 Rev 06.pdf` | 12/Jul/2016 |
| `Protocolo de comunicaciones CUORA MAX V6.2 Rev 00.pdf` | 21/Oct/2021 |
| `Protocolo de comunicaciones MAX CUORA V7.pdf` | Rev 00, 20/Jun/2022 |
| `Prueba Protocolo Cuora W7 - VB/` | Programa de ejemplo oficial: `Form1.vb`, `Form1.Designer.vb`, proyecto |
| `Protocolo de comunicación RS232 Systel.pdf` | Rev 10, solo peso (Croma, Clipse, etc.) |
| Guía de redes Cuora Max Rev 6, Instalación manual de drivers, Instalación Qendra MAX | Instalación y conexión |
| `QENDRA-Importacion-automatica-de-datos-ESP.zip` | PDF Rev 2 + 3 CSV de ejemplo |
| Manual de Instalación y Guía de Usuario Cuora Max | Copia publicada por un distribuidor |

**Búsqueda de otras revisiones:** no se encontró ningún otro protocolo público, ni implementaciones de terceros (GitHub ni foros).

### Qué versión de protocolo usa la balanza (sin suponerlo)
- Los 4 protocolos dicen en la firma digital "En este caso «0040»", siempre en la pág. 5. Ninguno documenta qué significa `S0060`. **No está documentado** a qué documento corresponde la firma `S0060`.
- **Evidencia real:** la lista (función 31) llegó con números de PLU de **4 dígitos** (`N0001`). Eso coincide con V4.0 (pág. 13) y V6.0 (pág. 15). **No coincide** con V6.2 ni V7 (pág. 13: "Nro PLU 6 Nros").
- V6.0 dice que la función 3 "No se utiliza en este equipo" (pág. 8). Así que, si es una Cuora Max, la lectura es la 62.
- **Conclusión:** el formato de la balanza es "de 4 dígitos" (V4.0 o V6.0). Cuál de los dos se sabe recién leyendo un producto. El código prueba la 62 (V6.0) y, si recibe E4, la 3 (V4.0). Nunca escribe con un formato que no haya leído en esa balanza.

## 2. Las dudas, una por una

| Duda | Qué dice la documentación | Fuente | Conclusión |
|---|---|---|---|
| **Significado de E3** | "E3= Se desatendieron datos." Nada más. | V6.0 pág. 4; V4.0 pág. 4; V6.2 y V7 pág. 4 | **No documentado:** no dice cuándo ocurre. |
| **Cómo salir del E3** | Nada. Solo "dará aviso al servidor para que este pueda re-procesar el mensaje". | V6.0 pág. 3 | **No documentado.** |
| **Secuencia de inicio** | No existe ninguna. "Unicast"; la 0 es "Broadcast". Para V6.0: "El sistema soporta transmisiones solo de modo «Unicast»". | V6.0 págs. 2-3 | **No documentado.** Que la balanza contestara al 0 (16:08) **no está documentado** para la Cuora Max. |
| **Tiempos** | Fin de trama por silencio, "aprox 5ms", sin pausas dentro de una trama. No hay plazos de respuesta. | V6.0 pág. 3; RS232 Rev 10 pág. 2 | Patagonia manda cada orden de una sola escritura y espera ≥60 ms entre órdenes: cumple. **No hay plazo documentado** para la respuesta ni para el cierre de la 31. |
| **DTR/RTS** | Nada en los protocolos. El ejemplo oficial solo configura `BaudRate = 115200` (Designer, línea 76). Lo demás queda en los valores por defecto de .NET: DTR y RTS **apagadas**, sin control de flujo, 8N1. | `Form1.Designer.vb` | **Diferencia con lo nuestro:** Patagonia las enciende. Con ellas encendidas funcionó a las 16:08, así que no es una falla demostrada. Queda registrado. |
| **Identificación** | El ejemplo trae `Text_IP.Text = "20"` (Designer, línea 164) y el manual muestra "Id : 20". | Ejemplo VB; manual, cap. 3 Conectividad | Ahora se prueba el 20 temprano en la búsqueda. |
| **Cierre de la 31** | La lista termina con "F" y la verificación. Nada sobre pausas. | V6.0 págs. 14-15 | **No documentado** si hay pausa ni cuánto dura. |
| **XOR en la 61** | V6.0 pág. 20, V6.2 y V7 pág. 18: "IP + Función + Datos", sin CRC. Para la función 87 Systel aclara: "Esta función no tiene en cuenta el CRC" (V6.0 pág. 30). Para la 61 no aclara nada. | Ver columna anterior | **Contradictorio:** la omisión podría ser un error del documento, porque cuando Systel quiere decir "sin CRC" lo dice. |
| **XOR en la función 4** | V4.0 pág. 8 dice "+ CRC" y V6.0 pág. 9 lo omite. El ejemplo VB agrega XOR a todas las órdenes (`Form1.vb`, `TramaTX = IP & ORDEN & PARAMETROS & ChrW(CRC)`). | Ídem | Igual que la 61. |
| **"Versión del PLU" en la 33** | "Versión del PLU 1 Letra", sin valores. | V6.0 pág. 10; V4.0 pág. 9; V6.2 y V7 págs. 8-9 | **No documentado.** |
| **Valores de la versión** | En la 31: 0 = creado en la balanza, 1 = gestionado desde la PC, 2 = modificado en la balanza. En la 62, "Gestión": 0 balanza / 1 PC. El ejemplo VB de la función 4 manda `"2"`. | V6.0 págs. 15 y 19 | Usamos "1" (gestionado desde la PC). Su significado está documentado, pero **no que la 33 lo acepte**. |
| **Caracteres del nombre** | `!"#$%&´()*+,-./0-9:;<=>?@A-Z[\]º_\`a-z{|}ñÑ` | Qendra Importar Rev 2, Nota 1 | Patagonia usa un subconjunto (sin ´ º ñ: la ñ pasa a n). No genera nada fuera de ese conjunto. |

**Defectos del ejemplo oficial (no los copiamos):**
- Manda la trama como texto (`SerialPort1.Write(TramaTX)`). En .NET eso convierte en "?" todo byte mayor a 127, así que una verificación ≥ 0x80 saldría mal.
- En su función 4 el campo "Mantener totales" va con "S", cuando el documento pide N o M.

## 3. Comparación de las conexiones

Cada sesión se cruzó con la versión del código que estaba publicada en ese momento: 16:04:28 (`1ff060f`), 16:27:19 (`f03d3b7`), 16:37:32 (`751d036` + `c7e0c28`).

| | 16:08 (anduvo) | 16:26 | 16:40 | 16:41 |
|---|---|---|---|---|
| **Código publicado** | `1ff060f` | **el mismo `1ff060f`** | `c7e0c28` | `c7e0c28` |
| Página / puerto | página con puerto elegido | página nueva, puerto elegido de nuevo | página nueva, puerto elegido de nuevo | misma conexión que 16:40 |
| Órdenes antes de la 1.ª al 20 | `01 17 16` (sin respuesta, 356 ms) y `00 17 17` (respondió el 20) | **ninguna** (número guardado → directo al 20) | ninguna | ninguna (conexión ya abierta hace ~29 s) |
| 1.ª respuesta del 20 | firma completa (81 ms) | E3 (96 ms) | E3 (93 ms) | E3 (79 ms) |
| Respuestas | 6 de 6 con verificación bien, salvo la lista (sin F) | 3 E3 | 18 E3 (reintentos a lo largo de ~10 s) | 12 E3 |
| Ms por respuesta | 78-113 (lista 187) | 79-96 | 71-93 | 71-91 |
| Bytes por respuesta | completos | 5 justos | 5 justos | 5 justos |
| Bytes descartados / apertura / cierre | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO | NO REGISTRADO |

**16:08 contra 16:26: mismo código, misma balanza.** Lo único que cambió de nuestro lado fue:
- **(a)** Con el número guardado, el código fue directo al 20, sin las órdenes previas al 1 y al 0. Esto lo introdujo nuestro cambio de "recordar la conexión", publicado a las 16:04.
- **(b)** Lo que quedó de la sesión de las 16:08: la lista cortada, sin saber si llegaron más bytes ni cuándo se cerró la página.
- **(c)** El puerto elegido de nuevo en Chrome. No se registraba cuál.

**Tiempos:** la balanza respondió con la misma demora en las buenas y en las E3 (`ms` − 60 a 70 ≈ 10-35 ms). La única respuesta larga (la lista) llegó de corrido y después hubo silencio de más de 60 ms.

**Coherencia:** en **ninguna** sesión con E3 se mandó nada al 1 ni al 0. En la única sesión buena, sí. Los datos son compatibles con "el E3 se limpia con una orden a otro número", **y también** con "la balanza cambió de estado". No hay forma de distinguirlo con lo que se registró.

## 4. Fallas encontradas y correcciones

1. **Lista cortada antes del cierre (FALLA NUESTRA, demostrada con bytes reales).** Se dejaba de leer a los 60 ms de silencio y lo que llegaba después se tiraba.
   - **Corrección:** se espera hasta el plazo de la orden (15 s en la lista) mientras la trama no cierre con su verificación.
   - **Pendiente:** que la balanza efectivamente mande el cierre **no está comprobado**.
2. **Bytes descartados sin registro (FALLA NUESTRA).** Ahora quedan anotados con su contenido. También se anotan la apertura, el USB elegido, las señales, el momento de cada byte, las pausas y cómo terminó cada respuesta (`SerialSystelLink.events`).
3. **"The port is already open" (FALLA NUESTRA, real 15:59:03).**
   - El panel no cerraba el puerto al salir de la pantalla: ahora lo cierra.
   - Si el puerto está tomado, antes se informaba "la balanza no contestó"; ahora dice que está abierto en otra pantalla o programa.
4. **Directo al número guardado (cambio nuestro, causa POSIBLE del E3, no demostrada).** Se volvió a la secuencia de las 16:08 (1 → 0 → número), solo con pings, también antes de cada reintento por E3.
5. **Respuesta precedida por restos de otra:** ahora se busca la trama correcta dentro de lo recibido (`findSystelReply`).
6. **Precio con centavos en una balanza sin decimales:** ya no se redondea; no se manda y se avisa.
7. **Reporte demasiado grande:** se acota a ~700 KB, recortando primero los eventos del cable.
8. **Identificación 20 temprano en la búsqueda:** es el valor del ejemplo oficial y del manual.

## 5. Pruebas (`npm run test`: 394 pasan)

**[REAL]** (12 pruebas, solo bytes de la balanza):
- Las tramas verifican, y se interpretan la firma, el ping y la configuración.
- La lista sin cierre no se acepta.
- La configuración partida en cualquier byte se arma igual, y con una pausa de 200 ms no se corta.
- La lista en paquetes USB queda "incompleta".
- El final atrasado de otra respuesta se anota y no confunde.
- Restos pegados adelante de la respuesta: se encuentra la trama correcta.
- Con E3 persistente se mandan pocas órdenes, solo de lectura.
- El respaldo con lo real se frena antes de pedir productos.

**[SINTÉTICO]** (4 pruebas, agregan lo que NO vimos):
- Una "F" final artificial con una pausa de 1,5 s.
- El cierre que llega tarde queda anotado.
- La hipótesis del E3 que se destraba.
- El puerto tomado por otra pantalla.

**Otras:**
- Envío bloqueado por defecto: no sale ninguna escritura.
- Desconexión del cable.
- Simulador según el documento: alta y cambio de precio con relectura y freno ante diferencias. Solo se usa con la escritura habilitada a mano en la prueba.

## 6. Lo que no se puede comprobar sin una balanza

Para **enviar productos y precios y verificar lo guardado** hace falta:

1. **Leer un producto real (62 o 3).** Nunca llegamos a hacerlo. Sin eso no se sabe si el formato es el de V6.0 o el de V4.0, ni cómo quedan los campos (nombre, precio, código, tipo, tara y el resto). Tampoco hay contra qué comparar lo guardado.
2. **El cierre de la lista:** si llega y cuánto tarda. Los bytes no se pueden deducir.
3. **La 33:** si acepta "1" en "versión", y que la relectura quede idéntica salvo el precio.
4. **La 61:** si lleva XOR o no (el documento y el ejemplo se contradicen), y si acepta la configuración EAN vacía.
5. **El E3:** qué lo provoca y cómo se sale.

Todo esto depende del firmware de la balanza, que no está en ningún documento público. Se resuelve con una Cuora Max de **banco** (prestada por un agente técnico o un distribuidor, o comprada), sin usar la del cliente:
1. Leer la balanza con el nuevo registro del cable.
2. Comparar 3 productos con lo que muestra su pantalla.
3. Reproducir el E3: hablar apenas abierto el puerto, cortar una lista a la mitad, estar en un menú.
4. Probar la 33 y la 61 en un PLU de prueba, releyendo.

Si en el banco está Qendra, un monitor de puerto serie mientras Qendra trabaja muestra cómo arma Systel la 33 y la 61.

**Criterios para habilitar el envío:**
- la lista cierra bien en 3 lecturas seguidas;
- la 62 coincide con la pantalla en 3 productos;
- la 33 y la 61 se releen idénticas;
- el E3 está explicado.

Recién ahí `allowWrites = true`, y solo para ese firmware.

---

# Revisión 4: cierre de puntos (2026-10-09, NO publicada)

## A. Secuencia de conexión del código final

Discovery (`systel-discovery.ts`) + respaldo (`systel-backup.ts`). Cada ping de la búsqueda espera hasta 350 ms. Entre órdenes, la respuesta se da por terminada tras 60 ms de silencio, o más si la trama no cerró. Ejecución real del código contra los bytes de las 16:08 (balanza simulada que tarda 20 ms):

| Paso | Código final, sin número guardado | Con número guardado (20) | Registro real 16:08 (ms de cada orden) |
|---|---|---|---|
| abrir 115200 8N1 + DTR/RTS encendidas | 0-3 ms | 0-1 ms | (no registrado) |
| `01 17 16` ping al 1 | 4 ms, sin respuesta, espera 350 | 1 ms, ídem | sin respuesta, 356 |
| `00 17 17` ping general | 371 ms | 354 ms | 89 (contestó el 20) |
| `14 02 16` firma | 467 ms | 447 ms | 81 |
| `14 17 03` ping | 560 ms | 540 ms | 78 |
| `14 27 33` configuración | 652 ms | 632 ms | 113 |
| `14 1f 0b` lista | 744 ms | 725 ms | 187 (cortada) |

- **"El 20 temprano"** solo actúa si el ping general (0) no contesta. En ese caso el orden pasa a ser 1 → 0 → 20 → 2 … 10, y después las otras velocidades. Con el número guardado, el primer paso es 1 → 0 → 20 (sin duplicados).
- **Ante un E1/E2/E3 en una lectura**, antes de reintentar se espera 300, 800, 1500, 3000 y 5000 ms, y se repite ping al 1 → ping general.
- La prueba `systel-evidence.test.ts` comprueba que el orden es idéntico al de las 16:08 en los dos casos, con un solo abrir de puerto.
- **Diferencia que sigue sin resolver:** DTR/RTS están encendidas, igual que a las 16:08. El ejemplo oficial las deja apagadas (valores por defecto de .NET).

## B. Programa de ejemplo oficial (`Form1.vb`, `Button3_Click`)

- **Cómo arma la trama:** `CRC = IP Xor Funcion`, y después `CRC = CRC Xor ASCII(c)` por cada carácter. Queda `TramaTX = ChrW(IP) & ChrW(Funcion) & PARAMETROS & ChrW(CRC)` y se manda con `SerialPort1.Write(string)`.
- **Botones del ejemplo:**
  - 1 peso, `""`
  - 23 ping, `""`
  - 6 marquesina, `"Esta es la marquesina de ejemplo"`
  - 3 leer PLU, `"0001"`
  - 4 alta, `"00012Activia Bebible Fr…SSOtros datos…"` (155 caracteres)
  - 5 borrar, `"0001"`
  - 26 apagar, `""`
- **No trae** las funciones 31, 33, 39, 61 ni 62.
- **Mismos bytes:** traduje ese algoritmo línea por línea. Para 1, 23, 3, 4 (con el dato del ejemplo), 6, 31, 33 y 62, Patagonia arma **exactamente los mismos bytes** que el ejemplo. El ping y la firma del ejemplo con IP 20 dan `14 17 03` y `14 02 16`, lo mismo que mandamos a la balanza real.
- **Corrección de la revisión 3:** dije que el ejemplo fallaba cuando el byte de control es ≥ 0x80. Es falso: con dirección ≤ 99, función < 128 y datos ASCII, el control es siempre < 0x80. Hay una prueba que lo demuestra.
- **El alta del ejemplo es de la Cuora 2** (función 4, tara de 6). Desarmado campo por campo: PLU `0001`, versión `"2"`, nombre, precio 1 `000500`, precio 2 `000500`, código `00001`, sección `05`, vencimiento `0000`, tipo `U`, tara `000000`. "Mantener totales" va con **`S`**, aunque el documento pide N o M. Ingredientes `S` + 100 caracteres. Lleva byte de control.

| | Coincide con el documento o el ejemplo | Sigue siendo hipótesis |
|---|---|---|
| Lectura (2, 23, 31, 39, 62) | Armado de la trama: idéntico al ejemplo. Campos: según el documento V6.0. | Formato real de la respuesta de la 62 (nunca leída) y cierre de la 31. |
| Cambio de precio (33) | Armado de la trama: idéntico. Campos: PLU 4 + versión 1 + lista 1 (6) + lista 2 (6), según V6.0 pág. 10. | Valor de "versión" (mandamos `1`): sin valores documentados. El ejemplo no trae la 33. |
| Alta (61) | Campos: V6.0 págs. 20-21. | Si lleva byte de control (el documento lo omite, el ejemplo lo agrega en la 4). Configuración EAN vacía. Qué responde. |

## C. Detección del protocolo

- **Los 4 dígitos solo descartan V6.2/V7.** Entre V4.0 y V6.0 cambian:
  - la función de escritura (4 o 61);
  - la tara (6 o 4);
  - el campo N/M;
  - el campo de gestión.
- La firma `S0060` no está documentada.
- **Por eso la escritura queda bloqueada por perfil:**
  - `SYSTEL_VERIFIED_WRITE_PROFILES` (firma + formato leído + evidencia) está **vacío**, y `systelWriteVerified("0060", cualquier formato)` = falso. Hay prueba.
  - El panel le pasa al cliente `allowWrites: systelWriteVerified(...)`, y el piloto ni siquiera llama al envío.
- **La lectura sí sigue:** prueba la 62 (V6.0) y, si recibe E4, la 3 (V4.0). Acepta solo una respuesta que encaje exactamente con el largo y los campos de ese formato.

## D. Recepción, puerto y concurrencia

- **Falla nueva encontrada (corregida):** por cómo funciona el XOR, **dos tramas válidas pegadas verifican como una sola**. Está comprobado con los bytes reales `14 17 45 33 75` + `14 17 30 30 44 47`. La búsqueda anterior probaba primero el buffer entero, así que una respuesta vieja que llegara tarde podía mezclarse con la nueva. Ahora se toma la **última** trama completa.
- Lista incompleta: nunca se acepta (sin F o sin control válido). Hay prueba con los 982 bytes reales.
- Byte de control: un byte cambiado en la configuración real se rechaza. Hay prueba.
- Datos pendientes: se anotan como descartados y no se confunden con la respuesta. Hay pruebas con restos reales.
- Cierre del puerto: al salir de la pantalla, y al desenchufar el cable (se suelta el puerto para elegirlo de nuevo).
- Reconexión: si se corta la lectura, la orden siguiente reabre una sola vez. Hay prueba.
- Intentos simultáneos: el botón no arranca un segundo intento mientras corre otro, y en el cable sale una orden por vez (cola). Hay prueba con dos órdenes a la vez.

## E. Qué está publicado

- **En producción:** el deploy `6ac937fb…` (18:52 UTC). Es la compilación de `294d9d9` y **mantiene bloqueada toda escritura Systel**. Lo comprobé en el JS publicado: `allowWrites ?? false`, y `changePrice`/`createPlu` devuelven "bloqueado" sin mandar nada. El piloto solo lee y nadie le pasa `allowWrites: true`.
- **La de las 16:52 (`6ac91bb0…`) es de otra sesión:** commit `099dd2f`, "Panel admin: pestaña Ventas con embudo" (migración 116). Tenía el piloto viejo, que sí mandaba precios.
- **No se pisó nada:** `099dd2f` está dentro de `294d9d9`, y los textos del embudo ("No se pudo cargar el embudo.", "No tiene tiempo ahora") están en el JS publicado a las 18:52.
- **Las revisiones 3 y 4 no están publicadas.**

## F. Procedimiento mínimo en una balanza de BANCO (nunca la del cliente)

Lo hace el equipo de Patagonia con una Cuora Max de prueba (prestada por un ATAS o distribuidor, o comprada), con una compilación de prueba que habilita la escritura **solo** para ese banco. Ninguna prueba automática reemplaza este procedimiento.

1. **Identificación.** Anotar el modelo, el firmware (menú) y el número de identificación. Cargar a mano **un** producto de prueba en un número libre alto (por ejemplo 7999), con precio y código conocidos, y sacarle foto a la pantalla.
2. **Lectura inicial.** "Leer la balanza" con el registro del cable. Se aprueba si:
   - la lista llega con "F" y control válido en 3 lecturas seguidas;
   - la lectura del 7999 coincide con la pantalla (nombre, precio, código, tipo);
   - queda guardado el respaldo completo.
3. **Cambio controlado (33)** sobre el 7999: precio original + 1 peso.
   - Respuesta esperada: ACK.
   - Releer: solo debe cambiar la lista 1. Todo lo demás (nombre, código, tipo, tara, el resto) debe quedar idéntico al respaldo.
   - Anotar el valor de "versión" que devuelve la 62 después del cambio.
4. **Lectura posterior.** Releer la lista y **todos** los productos: todos los demás deben quedar idénticos al respaldo, byte por byte.
5. **Restauración.** Volver el 7999 a su precio original con la 33, releer, y comparar con el respaldo inicial: idéntico.
6. **Alta (61), solo si los pasos 3 a 5 dieron bien.** Dar de alta un producto en otro número libre (por ejemplo 7998), primero **con** byte de control. Si contesta E5, probar **sin**. Releer y comparar campo por campo. Restaurar borrándolo **a mano desde el menú de la balanza** (Patagonia nunca manda la función 5).
7. **E3.** Con la misma balanza, intentar reproducirlo:
   - abrir el puerto y hablarle directo a su número;
   - cortar una lectura de lista a la mitad y cerrar la página;
   - dejar la balanza en un menú o con un ticket abierto.

   Anotar qué lo provoca y qué lo destraba.

**Resultado:** si los pasos 2 a 6 dan bien, se agrega el perfil (firma + formato + evidencia) a `SYSTEL_VERIFIED_WRITE_PROFILES`. Recién ahí se puede habilitar el envío en Patagonia.

> **La sección F queda REEMPLAZADA por la H de la revisión 5.** Ya no se prueba el alta "con y sin control" en la misma corrida, y precio y alta se validan por separado.

---

# Revisión 5: versión preparada para validar (2026-10-09, NO publicada)

## G. Versiones, por identificador

| Despliegue Netlify | Código | Systel |
|---|---|---|
| `6ac91088b654987e9033c6b8` | `1ff060f` | Piloto que **manda precios**. Búsqueda automática de la conexión. |
| `6ac915e551b21bad6da0b7fd` | `f03d3b7` | Igual, más la lista con espera de cierre. |
| `6ac9184a9f486cd94d7dfd21` | `751d036` + `c7e0c28` | Igual, más reintentos ante E3. |
| `6ac91bb01e087b307ebf0730` | `099dd2f` de **otra sesión** (embudo de ventas, migración 116), sobre `c7e0c28` | Piloto que **manda precios**. |
| **`6ac937fb0dec4c31d6693851`** (**EN PRODUCCIÓN**) | `294d9d9` (incluye `099dd2f`) | **Escritura bloqueada** (`allowWrites ?? false`, comprobado en el JS publicado). El piloto solo lee. |

**Guardado y NO publicado**, sobre `294d9d9`:
- **`45e2214`:** cierra el puerto al salir de la pantalla; "puerto ocupado" se informa distinto de "no contestó"; el 20 como alternativa en la búsqueda; reporte acotado; pruebas [REAL]/[SINTÉTICO].
- **`e687813`:**
  - la respuesta es la última trama completa (dos tramas válidas pegadas verifican juntas por XOR);
  - una orden por vez en el cable y un intento a la vez;
  - suelta el puerto al desenchufar;
  - escritura solo con un perfil validado;
  - pruebas de la secuencia contra las 16:08 y del ejemplo oficial.
- **Commit de esta revisión:**
  - permisos **por operación** (`writes: { price, create }`), con perfiles por operación + firma + formato, sin comodines;
  - el alta ya no prueba sola "sin control" ante un E5;
  - herramienta de laboratorio.

La secuencia de recuperación del E3 (1 → 0 → número) es una **HIPÓTESIS**: reproduce el orden de la sesión que anduvo, pero no está comprobado que evite ni que destrabe el E3.

## H. Formato del alta y validaciones separadas

- **Byte de control en la 61, forma por defecto "con control".** Justificación:
  - la regla general del protocolo pone "Verificación" en toda trama PC→balanza (V6.0 pág. 3);
  - cuando Systel exceptúa una orden lo dice expresamente (función 87: "Esta función no tiene en cuenta el CRC", V6.0 pág. 30), y para la 61 no lo dice;
  - la V4.0 pone "+ CRC" en la función 4 (pág. 8);
  - el ejemplo oficial lo agrega a todas las órdenes.

  La omisión en la 61 (V6.0 pág. 20, V6.2/V7 pág. 18) se trata como posible error del documento, **no comprobado**.
- **"Sin control"** existe solo como variante **experimental**: la elige la persona, en otra corrida, en el laboratorio. Ante un E5 la herramienta **se detiene** con un único intento. Hay prueba.
- **Validación por operación:**
  - un perfil = una operación ("precio" o "alta") + una firma exacta + un formato exacto + evidencia;
  - validar el cambio de precio no habilita el alta, ni al revés (hay prueba);
  - no hay comodines por modelo ni por versión.

## I. Herramienta de laboratorio (`systel-lab.ts` + `SystelLabPanel.tsx`)

- **Solo en una compilación con `VITE_SYSTEL_LAB=1`.** La compilación normal no la incluye: comprobado buscando su texto en el JS de producción (ausente) y en el de laboratorio (presente). Cada función exige `lab: true`.
- **Cambio de precio** (`runPriceChangeLab`):
  1. identificar (2 + 23);
  2. lista completa (31);
  3. formato inequívoco (62, o 3 si la 62 no existe), que tiene que coincidir con los dígitos de la lista;
  4. segunda lectura idéntica;
  5. **estado inicial guardado**;
  6. confirmación de la persona;
  7. cambio de **solo** la lista 1 (33);
  8. releer (solo cambió la lista 1);
  9. restaurar el precio original (33);
  10. releer y comparar con el inicial;
  11. lista igual a la del comienzo.
- **Alta** (`runCreateLab`): número libre, formato reconocido sobre un producto existente leído dos veces, confirmación, **una** forma de control, releer campo por campo, lista. La restauración es **borrarlo a mano desde el menú** (Patagonia nunca manda la función 5) y después `verifyCreateRestored`.
- **Se detiene ANTES de escribir** si:
  - la lista está incompleta;
  - una respuesta no pasa el control;
  - el formato es ambiguo o no reconocido;
  - las dos lecturas difieren;
  - la persona no confirma.

  Hay prueba de cada caso, una de ellas con los bytes reales de Los gringos (se detiene en "lista completa").
- **El informe** (JSON descargable) trae: cada paso con su resultado, ms y órdenes (bytes enviados y recibidos, ms, interpretación); el protocolo usado (firma, dígitos, formato, función de lectura y de escritura); los estados inicial, después y restaurado; los eventos del cable.
- Las pruebas de la herramienta usan el simulador ([SINTÉTICO]), salvo una [REAL]. **No validan una balanza real.**

## J. Procedimiento para una Cuora Max de banco (reemplaza la sección F)

1. **Preparar.** Compilación de laboratorio (`VITE_SYSTEL_LAB=1 npm run dev -w @patagonia/web`) en la PC del banco. Anotar el modelo, el firmware y la identificación. Cargar a mano el PLU 7999 con precio y código conocidos; foto de la pantalla.
2. **Cambio de precio** ("Probar cambio de precio", PLU 7999, precio actual + 1). Se aprueba si:
   - el resultado es `aprobado`;
   - el 7999 vuelve a su estado inicial;
   - la lista queda igual;
   - la pantalla de la balanza coincide.

   Repetir 3 veces. Descargar los 3 informes.
3. **Alta, en otra sesión y con otro informe** ("Probar alta (con control)", PLU 7998 libre). Se aprueba si:
   - el resultado es `restaurar_a_mano`;
   - la relectura coincide campo por campo;
   - la lista tiene el nuevo y no pierde ninguno.

   Borrar el 7998 a mano y tocar "Verificar restauración" (tiene que dar ✔).
   - Si da `fallo_al_escribir` con E5: **detenerse y analizar** el informe.
   - "Alta SIN control" se intenta solo después de ese análisis, como prueba aparte, con su propio informe.
4. **E3**, en una corrida aparte y solo lectura: intentar reproducirlo (hablarle apenas abierto el puerto, cortar una lista a la mitad, un menú abierto) con el registro del cable. Anotar qué lo provoca y qué lo destraba.
5. **Con los informes aprobados**, una persona agrega a `SYSTEL_VERIFIED_WRITE_PROFILES` **un perfil por operación aprobada**, con la firma y el formato **exactos** de esa balanza y la referencia a los informes. Otra firma u otro formato siguen bloqueados.

---

# Revisión 6: cierre de etapa (2026-10-10, en pausa hasta tener una Cuora Max de prueba)

## K. Correcciones finales

- **Respuesta que corresponde a la orden.** Se acepta solo si hay UNA trama posible (misma dirección, misma función, control correcto), y el contenido corresponde a lo pedido. En la lectura de un producto, el número de PLU tiene que ser el pedido. Una respuesta anterior válida pegada a la actual es AMBIGUA y no se usa. Hay una prueba con los bytes reales.
- **Escritura sin ACK.** Queda INDETERMINADA aunque la relectura muestre el valor nuevo. Se relee siempre y nunca se reintenta sola.
- **Solo productos destinados a pruebas.**
  - Cambio de precio: el producto tiene que existir y su nombre en la balanza tiene que empezar con `PRUEBA` y ser exactamente el que escribió la persona. Si no, se frena.
  - Alta: además de no figurar en la lista, la lectura directa de ese número tiene que contestar E7 ("no existe"), y el nombre a crear tiene que empezar con `PRUEBA`.
  - Ningún número (7999, 7998) se da por libre ni por "de prueba".
- **Compatibilidad (corrección).** Que otra balanza también use números de PLU de 4 dígitos NO confirma el formato de sus órdenes. Una prueba aprobada valida solo las operaciones y los campos que se ejercitaron, en esa firma y ese formato exactos. Con una firma distinta de S0060, lo de Los gringos sigue bloqueado.

## L. Para retomar

- **Producción:** Netlify `6ac937fb0dec4c31d6693851` = `294d9d9`, con la escritura Systel bloqueada.
- **Paquete:** `laboratorio-systel-<commit>.zip`, junto al repositorio. Las fuentes del lanzador y las instrucciones están en `tools/laboratorio-systel/`.
- **Próximo paso:** Cuora Max de prueba → pasos 0 y 1 del `LEEME.txt` (3 informes) → analizar → si salen "aprobado", agregar el perfil "precio" para esa firma y ese formato exactos. El alta se valida aparte.

## M. 2026-10-13 — Detalle del ticket desde la balanza (función 72) y revisión del E3

**Problema real.** Ticket de 2 artículos (op. 20-3095): TOTAL `2202000731184` = 22 + 02 artículos + $73.118; debajo de cada artículo `0 000000 000000`. El código no trae productos ni cantidades.

**Vía elegida: leer el ticket de la balanza (solo lectura).** Función 72 "Reporte de ventas", documentada igual en V6.0 (pág. 33), V6.2 y V7 (págs. 30-31): pedido `ddmmaa` inicio + `ddmmaa` fin; respuesta por artículo `Ticket Id(9)^fecha^hora^vendedor(2)^PLU(6)^sector(2)^unidades(4)^gramos(5)^drenado(5)^importe(12, ×100)` y `F` al final. Implementado en `systel-sales.ts` / `systel-ticket-detail.ts` / `systel-ticket-from-scale.ts`; Mostrador la usa al escanear el TOTAL si la PC tiene la Systel guardada por cable. Busca el ticket de HOY con ese total exacto, y cada artículo se carga con los gramos/unidades de la balanza. Se comprueba que cantidad × precio de Patagonia = importe de la balanza (±$1); si no, no carga nada. Nunca cobra el total sin detalle.
- **Nunca leída en una balanza real.** El formato sale del documento, y si no coincide exactamente se rechaza y el registro llega a soporte.
- Supuesto: N.º de PLU = código del producto (en Los gringos el ticket imprime "(C.PLU) 2" para el cajón y es el código 2). Lo protege la comprobación de importe.

**E3 = "Se desatendieron datos" (documento, pág. 4).** Revisión de los 6 registros del 13/10 (hora AR):

| Hora | Resultado |
|---|---|
| 11:52:31 | anduvo (ping + configuración) |
| 11:53:58 | E3 a todo |
| 11:54:26 | E3 a todo |
| 12:15:44 | E3 a todo |
| 12:16:22 | anduvo de nuevo, misma secuencia, **sin que conste ningún reinicio** |

- En las sesiones con E3 la balanza contesta cada orden, con su número y la verificación bien: la línea funciona y es la balanza la que no atiende.
- La secuencia enviada fue idéntica en las sesiones buenas y en las malas, así que el estado viene de la balanza, no de esa sesión.
- Esto contradice la hipótesis "queda trabada hasta apagarla después de la primera sesión".
- Hipótesis compatible con todo: la balanza está ocupada (operando o con un ticket abierto) en ese momento. **No comprobada.** La 72 reintenta 5 veces (~10 s) y si sigue E3 no carga nada.

### M.2 Controles agregados (mismo día, pedido del dueño)

1. **Ticket por identidad, no por importe.** La identidad es `systel:<balanza>:<fecha>:<N.º>:<vendedor>:<hora del 1.er artículo>`.
   - Con dos tickets sin cobrar del mismo total (y la misma cantidad de artículos, que da el código si el formato de sumas de la balanza tiene "AA"; se lee de la 39), Mostrador muestra los dos y la persona elige con la hora y el N.º de operación impresos. Nunca elige solo.
2. **Duplicados por identidad.** `pos_sale_items.scale_ticket` (migración 118) guarda el ticket. Se consultan las ventas NO anuladas desde cualquier PC; lo guardado en la PC sirve solo sin conexión. Si se anula la venta, el ticket se puede volver a cargar.
3. **Importe de la balanza.** `create_pos_sale` acepta `scale_amount` (con `source='scale'` y `scale_ticket`) y guarda line_total = importe de la balanza. El catálogo no se toca y sirve también para productos sin precio en Patagonia.
4. **Vínculo por código y unidad.** Se lee cada producto del ticket en la balanza (62/3) y se usan su CÓDIGO y su tipo de venta (P/C ↔ kg, U ↔ unidad/caja). El reporte tiene que traer gramos para los pesables y unidades para los unitarios.
5. **E3, sin descartar nuestra integración.** Cada racha de E3 empezó después de una sesión nuestra que anduvo bien y se cerró: 09/10 bien 13:08 → E3 13:26-13:41; 13/10 bien 11:52 → E3 11:53-12:15 → bien 12:16.
   - Nuestra forma de trabajar era abrir, subir DTR/RTS, ping a 1 y a 0, y cerrar (DTR/RTS bajan) en cada operación.
   - Ahora Mostrador abre una vez y deja la conexión abierta mientras está en pantalla, como el programa de ejemplo oficial.
   - Cada intento manda a soporte si la conexión era nueva y cuánto pasó desde la última lectura buena, para distinguir la causa con datos reales.
   - No probado.
   - Diagnóstico sin venta: Stock → Balanza → "Leer las ventas de hoy (solo lectura)".

**Pruebas.**
- Simuladas: 20 automáticas (`systel-sales.test.ts`) y la pantalla real de staging (`tests/e2e/ui-ticket-detalle-balanza.mts`): dos tickets iguales → elegir; el otro se carga solo; tercera vez bloqueado; anulada → se puede volver a cargar. Se cobró el importe de la balanza con el precio de Patagonia en $9.999, y el stock bajó por la cantidad de la balanza.
- Real: ninguna respuesta 72/62 de la balanza de Los gringos todavía.
