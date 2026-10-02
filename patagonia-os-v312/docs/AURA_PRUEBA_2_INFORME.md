# Kretz Aura — segunda prueba de escritura: cómo se lee el resultado

Prueba versión `2026-10-02g` (sin borrado: decisión del dueño, 2026-10-02), cliente "Pollo y mar". El resultado llega solo a `scale_support_reports`, en `connections[0].auraWriteTest`. Trae:

- `items`: lo que se mandó y lo que quedó, con las diferencias campo por campo.
- `before` / `after`: la lista completa de productos antes y después.
- `exchanges`: los bytes de cada comando.

Además hay dos fotos de tickets (PLU 99 y PLU 98).

## Productos de prueba

| PLU | Nombre | Letra | Validez | Código | Precio | Para qué |
|---|---|---|---|---|---|---|
| 97 | PRUEBA KILO | P | 2 | 97 | 2000 | ¿Se respeta P con días de validez? |
| 98 | PRUEBA UNIDAD | C | 0 | 98 | 500 | ¿C = por unidad? Ticket de venta por unidad |
| 96 | PRUEBA UNIDAD V | N | 3 | 96 | 300 | ¿N = por unidad con validez? |
| 99 | PRUEBA PATAGONIA | D | 0 | 500 | 1234 | ¿Queda un código distinto del PLU? Ticket por kilo: ¿el código de barras lleva el código o el PLU? |

## Criterios

1. **Seguridad (excluyente).**
   - `verdict` tiene que ser `ok`.
   - La prueba se frena sola, con `verdict` = `otros_cambiaron`, si después de cualquier carga cambió un producto de la clienta. Se frena con `diferencia` si un producto de prueba no se pudo releer, o si volvió con otro nombre, precio, tara o validez.
   - Los 6 productos de la clienta (1, 2, 3, 6, 8 y 11) tienen que estar idénticos en `after`.
   - Si algo de esto falla, se frena todo y se pide ayuda a Kretz.
2. **Letras (hipótesis H1).**
   - Confirmada si en 97, 98 y 96 queda la misma letra que se mandó.
   - Si la balanza cambia alguna, la letra la decide ella: se manda la que ella pone y se vuelve a leer.
3. **Código.**
   - Si 96, 97 y 98 conservan su código (igual al PLU), el código se escribe bien cuando coincide con el PLU. En el envío masivo se usa código = PLU, igual que en los productos de la clienta.
   - Si el 99 conserva 500, la balanza acepta también códigos distintos.
   - Si 96, 97 y 98 vuelven en 0, la balanza no toma el código por este comando: hay que preguntarle a Kretz antes del envío masivo.
4. **Por kilo y por unidad.**
   - Ticket del 99: tiene que mostrar peso y "$/kg".
   - Ticket del 98: tiene que mostrar cantidad (2) y precio por unidad, y no peso.
5. **Código de barras.**
   - Leer los 13 dígitos impresos en el ticket del 99. Si aparece 00500, el código de barras lleva el código del producto. Si aparece 00099, lleva el número de PLU.
   - Comprobar que el lector de Mostrador (`scale-barcode.ts`) lo entiende con el formato de la clienta.
   - Si el ticket sale sin código de barras, la balanza lo tiene apagado (manual §7.1.7, formato "NO").
6. **Retirar los productos de prueba.**
   - Esta prueba NO borra nada; los 4 quedan en la balanza.
   - Cómo retirarlos se decide aparte. El borrado a mano desde la balanza está documentado en el manual (§8.2.3) y no toca otros productos. El borrado por cable (3005) no se usa en la Aura hasta conocer cómo se comporta.

## Resultado

Prueba del 2026-10-02 a las 12:59 AR (versión 2026-10-02g), con fotos de los tickets T.0029 y T.0030.

- **Seguridad: OK.** `verdict` = ok. Las 4 cargas contestaron 01. Los 6 productos de la clienta quedaron idénticos antes y después.
- **Nombre, precio, tara y validez:** se guardaron exactamente como se mandaron en los 4.
- **Letra: la hipótesis H1 queda DESCARTADA.**
  - Se mandó P, C, N y D, y la balanza guardó **D en los 4**.
  - En los tickets, D se vende por kilo: el 99 salió "1.130kg @ 1234.00$/kg" y el 98 ("PRUEBA UNIDAD") salió "1.130kg @ 500.00$/kg".
  - Con este registro, todo lo que se carga queda **por kilo**. No se pudo crear un producto por unidad.
- **Código:** se mandó 97, 98, 96 y 500, y la balanza guardó **0 en los 4**.
- **Conclusión:** la letra y el código no se toman de esas posiciones del registro 2005. Lo más probable es que el formato de escritura no sea igual al de lectura en esa parte. Eso solo lo puede aclarar Kretz.
- **Código de barras:** los dos tickets, con totales distintos (1394 y 1130), traen el mismo código: `2099998000008` (EAN-13 válido). No lleva ni el producto, ni el peso, ni el importe. Con la configuración actual de la balanza, Mostrador no puede usar estos tickets. El encabezado del ticket es el de fábrica ("KRETZ S.A.").
- **Riesgo para el envío masivo:** si se reescribe un producto de la clienta con este método, probablemente quede en D con código 0. Por ejemplo, PASTELITOS pasaría a venderse por kilo. **El envío masivo NO se habilita.**
- **Quedan en la balanza:** los PLU 96 a 99 (de prueba, por kilo) y dos ventas de prueba en los totales del día ($1394 y $1130).
