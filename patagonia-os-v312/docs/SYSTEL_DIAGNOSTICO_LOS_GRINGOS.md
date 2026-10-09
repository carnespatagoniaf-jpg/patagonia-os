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
