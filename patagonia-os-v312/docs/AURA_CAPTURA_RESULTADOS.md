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

## 5. Pendiente de captura

- Alta de un producto **por kilo** y uno **por unidad**: el 2005 que arma iTegra para el modelo 3300ECO.
- Producto con **código distinto del número de PLU**.
- **Cambio de precio** (pantalla "Cambio de precio" + "Transmitir novedades").

Archivo de prueba para cargarlos en iTegra con su importación oficial: `plu_prueba.txt`. Va separado por `;` y tiene estos campos: número, código, nombre, precio, departamento, etiqueta, tipo (P/N) y vencimiento.
