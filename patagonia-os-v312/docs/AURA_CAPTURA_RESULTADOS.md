# Kretz Aura: mensajes capturados de iTegra (oficial) contra la Aura simulada

Fuentes:

- iTegra 4-148 portátil (archivo idéntico al oficial, SHA-256 `26DFC99B…`) en la PC del dueño.
- La Aura simulada: `scripts/aura-captura.ts`, que contesta con los bytes reales de la Aura de la clienta.
- El registro de JDataGate 2.30 (`iTegra.log`) y el archivo `INFO.JDG`.

La balanza real no participa.

Etiquetas:

- **CAPTURADO**: lo mandó iTegra.
- **REAL**: ya visto en la Aura de la clienta.
- **HIPÓTESIS**: no comprobado en la balanza.

## 1. Configuración del equipo en iTegra (CAPTURADO, 2026-10-02)

- En la base de iTegra queda así: `EQUIPOS(1,'aura prueba','3300ECO','99998','TCP/IP','127.0.0.1','1001',…)`. O sea, **la Aura Eco es el modelo interno "3300ECO"**.
- iTegra le pasa a JDataGate `COM.JDG = "01","H""3","TCP","127.0.0.1","1001"`. La Aura es **tipo de equipo H** (coincide con la REAL), número 01 y 3 reintentos.
- iTegra escribe los comandos en `INFO.JDG`, uno por línea y sin el inicio, el fin ni el checksum. JDataGate agrega esas partes, los manda y anota cada respuesta.

## 2. "Probar red" (CAPTURADO)

| Mandó iTegra | Bytes | Respuesta (la de la Aura REAL) |
|---|---|---|
| `H010001` | `02 48 30 31 30 30 30 31 36 3c 04` + `0d 0a` | `07 48 30 31 30 30 30 31 37 31 04` |
| `H011500` | `02 48 30 31 31 35 30 30 37 31 04` + `0d 0a` | `…AUI-030KMFBAPP4KAR  V1.00  6Feb24 00 …` |

## 3. "Importar desde equipo configurado": lectura de todos los productos (CAPTURADO)

| Mandó iTegra | Respuesta |
|---|---|
| `H01` `5005` `00000000000000` (**14 dígitos**) | `05 01` + `000001FRUTILLA        P0000100010500000005` |
| `H01` `5005` `000001` | PLU 2 (PASTELITOS) |
| `H01` `5005` `000002` … `000011` | PLU 3, 6, 8, 11 |
| `H01` `5005` `000011` | `05 40` (no hay más) |

**iTegra no mandó ningún comando de configuración ni de modelo de datos** (ni 5002, ni 1xxx) para leer una Aura.

## 4. Diferencias con lo que manda Patagonia hoy

| Punto | iTegra (CAPTURADO) | Patagonia | ¿Importa? |
|---|---|---|---|
| Trama, checksum y tipo H01 | Igual | Igual | — |
| Prueba de conexión | 0001 y 1500 | 0001, 0002, 1500… ("Probar todo") | No: 0002 contesta "inexistente" sin efecto (REAL) |
| Primer 5005 | Argumento de **14 dígitos** de ceros | 6 dígitos (`000000`) | No para leer: la Aura REAL contestó al de 6. Que acepte el de 14 es HIPÓTESIS, aunque es lo que usa el programa oficial |
| Después de cada trama | Agrega `0D 0A` (lo agrega el driver) | Nada | La Aura REAL contestó sin el `0D 0A` (comprobado) |

## 5. Escritura de productos: "Transmitir todo" (CAPTURADO, 16:36)

Orden completo de lo que mandó iTegra:

`0001` → `1024 00001` → `1090 99998` → `1091 99999` → `1030 0010` → `1050 4` → `1070 200200120` → `1040 <fecha y hora>` → **`4005` (BORRA TODOS LOS PLU)** → `2005` ×4 → `4015` → `2015 <empresa>` → `1070 2002001` → `0001`

Registros 2005 (42 caracteres):

| Producto | Registro mandado |
|---|---|
| Por kilo, código 50, 5 días | `000050PRUEBA KILO     000050P1234000000005` |
| Por unidad, código 51 | `000051PRUEBA UNIDAD   000051N0500000000000` |
| Por kilo, código 777 | `000052PRUEBA CODIGO   000777P0999000000000` |
| Por unidad, código 888, 3 días | `000053PRUEBA UNI COD  000888N0300000000003` |

**Formato de escritura:** PLU (6) + nombre (16) + **código (6)** + **tipo (1: P o N)** + precio (6) + tara (4) + validez (3).

**Diferencia clave con la lectura:** al leer, la Aura devuelve el tipo en la posición 22 y el código en las 23-28; al escribir van al revés. Patagonia escribía en el orden de lectura, y por eso la balanza real ponía "D" y código 0 (5 escrituras reales). Queda **COMPROBADO** que el formato que manda iTegra es ese. Que la balanza real lo guarde y lo devuelva bien es **HIPÓTESIS** fuerte: el programa oficial lo usa. Falta una sola prueba real.

**Precio:** iTegra multiplicó por 100 (1234 → `123400`; supone 2 decimales). En la Aura de la clienta, `001234` se imprimió "1234.00$/kg" (ticket REAL), así que Patagonia manda pesos enteros. Si una balanza estuviera configurada con decimales, habría que multiplicar: queda como parámetro a confirmar por balanza.

## 6. Cambio de precio: "Cambio de precio" + "Transmitir novedades" (CAPTURADO, 16:40)

`0001` → `1024` → `1090` → `1091` → `1030` → `1050` → `1040` → `2005 000050PRUEBA KILO     000050P1300000000005`

Reenvía **el registro completo** con el mismo código y tipo, y el precio nuevo. **No borra nada.**

## 7. Qué toma Patagonia y qué no

- **Toma:** el formato del 2005 (`buildAuraWriteRecord`, `rewriteWithNewPrice` en `kretz/aura-plu.ts`) y la lectura con 5005, que ya era idéntica.
- **No manda:**
  - 4005 (borra todos los productos);
  - 4015 / 2015 (empresa);
  - 1091 (clave de programación);
  - 1024 / 1030 / 1050 / 1040 (brillo, tiempos, impresor, fecha).

  Son configuraciones de iTegra que no hacen falta para cargar precios.
- **Código de barras:** iTegra manda `1070 2002001`, o sea inicio 20, importe (0), inicio no pesable 20, importe (0) y formato 1 (2-5-5). Coincide con la recomendación de poner PESO = NO en el menú de la balanza.

## 8. Lo que falta confirmar en la balanza real (UNA prueba)

`kretz/aura-write-test.ts` (versión `2026-10-02h`) carga los productos de prueba del 96 al 99 con el formato de iTegra (P/N y códigos 97, 98, 960 y 500), los relee y compara.

- **Éxito:** que vuelvan con su tipo (P/N) y su código, sin cambios en los 6 productos de la clienta.
- Más dos tickets, uno del PLU 98 (por unidad) y uno del PLU 99 (código 500), para ver la venta por unidad y el código de barras.
