# Balanzas Systel: informe técnico (2026-10-04)

Etiquetas: **DOCUMENTADO** (lo dice un documento oficial de Systel), **EJEMPLO** (lo hace el programa de ejemplo oficial de Systel), **HIPÓTESIS** (falta comprobar en una balanza real).

Nada de esto está programado ni publicado. Kretz Report LT y Kretz Aura no se tocan: Systel va a ser un módulo aparte (`features/inventory/systel/`).

## Fuentes (sitio oficial soporte.systel-global.com, "Instructivos")

| Documento | Fecha | Qué cubre |
|---|---|---|
| Protocolo de comunicación RS232 Systel, Rev 10 | — | Solo lectura de peso (Croma, Clipse, Bumer, etc.) |
| Guía armado de redes Cuora Max (USB/ETH/WiFi), Rev 6 | 2019 | Conexión física y de red |
| CUORA Instalación manual drivers | 2022 | Driver USB (chip FTDI FT232) |
| `Protocolo-Cuora-2-y-Cuora-MAX.zip`: Cuora 2 V4.0 (2010), Cuora Max V6.0 (2016), V6.2 (2021), **V7.0 (20/06/2022)**, y un programa de ejemplo en Visual Basic con su código | 2022 | **Lectura y escritura de productos** |
| `QENDRA-Importacion-automatica-de-datos-ESP.zip` (Rev 2) | 2020 | Formato CSV que Qendra importa sola |
| `Formato-CSV-Systel-Suite-NEO.zip` | 2023 | Formato CSV de la Cuora Neo (importación por FTP/SFTP) |
| Manuales de usuario Cuora Max y Cuora Neo | — | Tipos de venta, códigos de barras, importación FTP |

## 1. Modelos

| Modelo | Productos en memoria | Cómo se integra |
|---|---|---|
| **Cuora Max** (la más común) | 8.000 | Protocolo propio V6/V7 por USB o red (DOCUMENTADO) |
| **Cuora 2** (anterior) | ~4.000 | Protocolo V4.0, con otro formato de producto (DOCUMENTADO) |
| **Cuora Neo** (táctil) | — | No tiene protocolo serie: importa un CSV desde un servidor FTP/SFTP (DOCUMENTADO) |
| Croma, Clipse, Bumer, Maya | sin productos para PC | Solo lectura de peso (protocolo RS232 Rev 10) |

## 2. Protocolo Cuora Max (V7.0, igual a V6.2 en las funciones)

**Trama PC → balanza (DOCUMENTADO):** `dirección (1 byte, 0-99) + función (1 byte) + datos ASCII + verificación (XOR de todos los bytes anteriores)`.
- La dirección es el número de "Identificación" de la balanza (menú 11 → 3 → 1). 0 = broadcast.
- **EJEMPLO:** dirección y función van como bytes binarios (`ChrW(número)`), no como texto.
- El inicio y fin de trama se detecta por silencio (~5 ms): la trama se tiene que mandar entera, sin pausas.
- Respuesta: misma forma. `ACK` = recibido y procesado. `E1`…`E9` = error (E1 verificación, E2 buffer lleno, E4 función desconocida, E5 largo incorrecto, E6 fuera de límites, E7 no existe, E8 dato inválido, E9 desborde).

**Puerto (EJEMPLO):** 115200 baudios, 8 bits (el ejemplo no fija paridad ni stop: por defecto en .NET es sin paridad y 1 stop; HIPÓTESIS hasta la prueba). USB = chip FTDI FT232 → puerto COM → Web Serial de Chrome, como Kretz.

**Red (DOCUMENTADO):** módulo Lantronix, TCP **10001**, el mismo protocolo. Un navegador no puede abrir TCP directo: haría falta un programita local (como el agente de impresión) o usar USB. Recomendado: USB.

### Funciones que usaría Patagonia (solo estas)

| Función | Para qué | Riesgo |
|---|---|---|
| 2 Firma digital | Modelo, capacidad, versión de protocolo, cantidad de PLU y **decimales del precio** | Solo lectura |
| 23 Ping | ¿Está conectada? ¿Actualizada? | Solo lectura |
| 39 Configuración completa | Respaldo de la configuración (códigos de barras, decimales, etc.) | Solo lectura |
| 31 Lista de PLU | Qué números de PLU hay, y si cada uno lo creó la balanza (0), la PC (1) o se modificó en la balanza (2) | Solo lectura |
| 62 Leer PLU completo | **Respaldo** de cada producto | Solo lectura |
| 33 Cambio de precio | "Cambia los precios manteniendo todos los demás datos intactos. Se mantienen los totalizadores de ventas" | Escribe solo el precio |
| 61 Escribir PLU completo | Productos nuevos | Escribe un producto |

**Nunca:** 5 (borrar PLU), 9 (borrar sector: **borra todos sus PLU**), 26 (apagar), 32 (cierre de ventas, pone totales a cero), 42 (cambia decimales), 35/7/8/12/15/17/22/40/41 (configuración), 69/70/71/68 (borrados).

### Producto (función 62 / 61)

Número de PLU (6) + [62: gestión 1] + nombre (18) + 5 × (precio 6 + rango 6) + **código de PLU (6, el del código de barras)** + sector (2) + vencimiento (4) + **tipo de venta (P pesable, U unitario, E escurrido, C congelado)** + tara (4, gramos) + % agua (4) + tabla nutricional (S/N + 30 + 4 + 4 + 10×4) + origen (4) + conservación (4) + receta (4) + lote (12) + tipo EAN (1) + configuración EAN (12) + ingredientes (S/N + 100).

- **Número de PLU ≠ código de PLU.** El número es la posición en la balanza (1-8.000); el código es el que va en el código de barras. Qendra recomienda usar el mismo.
- **Precio:** 6 números sin coma. Los decimales los dice la firma digital (D = 0 o 2). Con 0 decimales el tope es $999.999; con 2, $9.999,99 (el mismo problema que en la Kretz, pero acá se puede **leer** de la balanza antes de mandar nada).

### Inconsistencias del documento (a confirmar en la prueba)

1. Función 61: el texto dice "IP + Función + Datos" sin verificación; todas las demás llevan verificación. Lo más probable es una omisión del documento.
2. Firma digital: la versión de protocolo dice "En este caso 0040", copiado del documento de la Cuora 2. El valor real de la Max no está documentado.
3. Función 33: lleva "Versión del PLU (1 letra)" sin decir qué valores acepta.
4. Función 4 (escribir PLU) aparece sin campos en la V7; el ejemplo oficial la usa con un formato corto. Patagonia usaría 61, que sí está completa.
5. Función 61 manda 5 listas de precios con rango; si la balanza tiene solo 2 en uso, mandaríamos 0 en las otras (como dice el documento: "0 = precio sin rango definido").

### Cuora 2 (V4.0, 2010)

Mismo armado de trama. Producto con número de 4 dígitos, código de 5 (hasta 99.997), 2 listas de precios y la letra "N"/"M" (N pone los totales de venta a cero; M los mantiene). Funciones 3 (leer) y 4 (escribir). Necesita su propio formato, pero el mismo transporte.

## 3. Alternativas oficiales sin protocolo

- **Qendra (Cuora/Cuora Max):** importa sola un CSV (`;`, sin encabezados) cada X minutos desde una carpeta y lo transmite a las balanzas. Campos básicos: sección; código PLU; descripción (18); número PLU (1-8.000); precio 1; precio 2; tipo (PESO/UNIDAD); vencimiento; otros datos. Tiene opciones peligrosas que hay que dejar **apagadas**: borrar los productos que no estén en el archivo. Depende de tener Qendra instalado.
- **Cuora Neo:** la balanza misma baja un CSV desde un servidor FTP o SFTP (formatos de 9, 26 o 31 campos; precio con 2 decimales; nombre hasta 56). Para eso Patagonia necesita publicar el archivo en un servidor FTP/SFTP (hoy no tenemos uno).

## 4. Qué se puede garantizar y qué falta

**Garantizado por documentación:** formato de trama, funciones de lectura (firma, ping, lista, producto, configuración), cambio de precio que conserva todo, tipos por kilo/unidad, códigos de error, CSV de Qendra y de la Neo, lectura de peso de las balanzas simples.

**Pendiente de una prueba real:** paridad/stop, si la 61 lleva verificación, la letra de versión de la 33, la versión real de protocolo, los decimales de esa balanza, y que una escritura en un número libre vuelva idéntica.

## 5. Prueba física propuesta (una sola, con una Cuora Max por USB)

1. Solo lectura: firma (2), ping (23), configuración (39), lista (31) y **todos** los productos (62) → respaldo guardado.
2. Escritura en un número de PLU **libre** (que no esté en la lista): producto de prueba por kilo y otro por unidad (61), releer (62) y comparar campo por campo.
3. Cambio de precio del de prueba (33), releer y comparar.
4. Releer la lista y comprobar que los productos de la clienta no cambiaron. Ante cualquier diferencia, frena.
Los productos de prueba quedan en la balanza (no se borra nada); el cliente los puede borrar a mano.
