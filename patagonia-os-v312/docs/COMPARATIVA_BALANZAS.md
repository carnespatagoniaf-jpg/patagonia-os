# Balanzas: sistema actual contra el nuevo (prueba comparativa, 27/11/2026)

**En una línea:** de 21 casos reales de clientes, el sistema actual (`main`) hace mal **19**; el nuevo
(`integracion/balanzas-etapa1`) hace mal **1** (E15, ver "Lo que sigue mal").

## Cómo se probó

- Cada caso sale de un problema real: la auditoría del 26/11, los commits de cada arreglo y etiquetas impresas por
  balanzas de clientes (banco `etiquetas-reales.json`). Los casos están en
  `apps/web/src/features/scales/comparativa/escenarios.ts`, con cliente, fecha, qué pasó, entrada y resultado correcto.
- El mismo caso se corrió **dos veces**: una con el código de `main` y otra con el de la rama nueva. Se usaron las
  funciones reales del sistema y balanzas simuladas (Report, Aura, Cuora Max, el programa de la PC para las balanzas
  por red). Las balanzas simuladas son las mismas para los dos. Los resultados de abajo son **lo que pasó al correrlo**,
  no lo que "debería" pasar.
- Para repetirla: `node --import tsx scripts/comparativa-balanzas.mjs --viejo <carpeta de main>/patagonia-os-v312`.
- La parte "nuevo" quedó en el test normal de la web (`comparativa.test.ts`): si un cambio vuelve a romper un caso, el
  test falla.

## Resultado

| # | Caso (cliente, fecha) | Antes (main) | Ahora (nuevo) | ¿Resuelto? |
|---|---|---|---|---|
| E01 | Producto 998 cobrado como TOTAL (Pollo y mar, auditoría 26/11) | ❌ Se cobra como TOTAL de $2.106, sin producto ni stock | ✅ Pregunta si es el TOTAL o el producto | Sí |
| E02 | TOTAL de la Aura sin bajar stock (Pollo y mar, 15/10) | ❌ Entra como "Ticket de balanza" y se cobra sin productos ⁽¹⁾ | ✅ No deja cobrar hasta detallar los productos del ticket | Sí |
| E03 | Systel + Kretz: etiqueta real de M2 (24/10) | ❌ La Systel la lee como PATA DESH. de 856,750 kg | ✅ Matambre 4,275 kg $58.567,50 | Sí |
| E04 | Systel + Kretz: etiqueta real de Oliem (18/11) | ❌ La Systel la lee como ALITAS de 205,183 kg | ✅ PROMO PATA 1,555 kg $5.183 | Sí |
| E05 | El Abastero: dos Kretz se pisan el formato (24/11) | ❌ El formato cambia y CAJA FORMITA $42.000 se lee como NALGA $27.420 ⁽²⁾ | ✅ El formato no cambia; CAJA FORMITA $42.000 | Sí |
| E06 | Oliem: una Report pisa el formato de la otra (25/11) | ❌ El formato del local cambia (esta etiqueta en particular se siguió leyendo bien) ⁽²⁾ | ✅ El formato no cambia | Sí |
| E07 | Oliem: códigos 6000+ salteados (25/11) | ✅ Se mandan | ✅ Se mandan | Ya andaba ⁽³⁾ |
| E08 | Local solo con Systel y un formato viejo (Carnes premium, El Dorado, Los gringos…) | ✅ Lee la Systel | ✅ Lee la Systel sin preguntar | Ya andaba ⁽⁴⁾ |
| E09 | Kretz con un error a mitad de la lectura (29/10) | ❌ Escribe encima: la NALGA pasa a ser MATAMBRE | ✅ No escribe nada y avisa | Sí |
| E10 | Systel con un envío frenado (Los gringos, registros reales) | ❌ Mostrador no guarda nada de lo que sí quedó grabado | ✅ Guarda los productos que quedaron (1 y 13) | Sí |
| E11 | Aura: código de barras rechazado y "Listo" | ❌ Dice que salió bien | ✅ Avisa que el código de barras no quedó | Sí |
| E12 | Envío a medias informado como éxito (Aura "ya igual") | ❌ "Ya está todo listo" sin haber mandado el código de barras | ✅ Avisa que falta y lo manda | Sí |
| E13 | "Enviar todos" sin releer (Report con iTegra) | ❌ "2 enviados con éxito" y uno no quedó ⁽¹⁾ | ✅ Relee: 1 confirmado, avisa el otro ⁽¹⁾ | Sí |
| E14 | Mostrador arranca con el formato de fábrica (TripleS, PC nueva) | ❌ Agrega 0,017 kg (el papel dice 0,175) ⁽¹⁾ | ✅ "Cargando la balanza…", no agrega nada | Sí |
| E15 | Sucursal sin formato guardado (TripleS, 13/10) | ❌ Agrega 0,017 kg sin avisar | ❌ **Agrega 0,017 kg sin avisar** | **No** |
| E16 | La misma balanza registrada varias veces (Los gringos 4×, Carnes premium 3×…) | ❌ La registra como nueva | ✅ Pregunta "¿Es la Balanza Kretz?" | Sí |
| E17 | Dos balanzas por red se cortan entre sí | ❌ Lo que se le manda a la A le llega a la B | ✅ Cada una contesta lo suyo | Sí |
| E18 | Mostrador cierra el puerto de otra parte ("puerto ocupado") | ❌ Le cierra el puerto a la sincronización | ✅ No lo cierra y avisa | Sí |
| E19 | Solo lectura manda productos a la balanza | ❌ Ve el botón y puede mandar ⁽¹⁾ | ✅ Ve el estado, sin enviar ⁽¹⁾ | Sí |
| E20 | La Report deja el puerto tomado (Giuseppe, Oliem) | ❌ El puerto queda tomado al terminar | ✅ Queda libre | Sí |
| E21 | La calibración elige un formato con dudas | ❌ Guarda uno que puede leer otro producto | ✅ Pide el N.º de producto u otra etiqueta | Sí |

**Resumen:** 21 casos. Mal antes: **19**. Mal ahora: **1**. Resueltos: 18. Ya andaban: 2 (el nuevo no los rompió).

## Lo que sigue mal (hallazgo)

- **E15. Sucursal sin formato guardado.** Si el local no tiene formato guardado en la base (no es "cargando", es
  "no hay"), Mostrador lee con el formato de fábrica de Kretz. La etiqueta de la Systel de TripleS, MUZARELLA 0,175 kg
  (`2001230001759`), entra como **0,017 kg sin ningún aviso**. El arreglo C5 cubre solo la PC nueva mientras carga.
  Lo que habría que hacer: con el formato de fábrica sin calibrar, no agregar una etiqueta de peso sin confirmar los
  kilos (o pedir calibrar). Está marcado como pendiente en `comparativa.test.ts`. **No se tocó el código de
  producción.**

## Notas para leer bien la tabla

1. ⁽¹⁾ **Ejecución parcial.** Ese paso de `main` vive dentro de una pantalla (componente de React) y no se puede correr
   fuera del navegador. Se corrió la lectura o el envío real y se citó la línea de la pantalla que decide: E02
   (`useSaleTicket.ts`, línea "Ticket de balanza"), E13 (`ScaleSyncPanel.tsx:571`, cuenta los "01"), E14
   (`Sale.tsx:177`, arranca con el formato de fábrica) y E19 (`Inventory.tsx:1006`, solo pide plan Estándar). En E19
   la parte de la base de datos (migración 224) no se probó acá.
2. ⁽²⁾ En `main`, El Abastero y Oliem tienen un arreglo **solo para ellos** (una lista fija con el número de cada
   empresa). La prueba usa una empresa que no está en esa lista, que es lo que le pasaría al próximo local con dos
   Kretz. Con su número real, `main` no pisa el formato de esos dos.
3. ⁽³⁾ E07 ya estaba arreglado en `main` el 25/11 (Report con etiqueta de 5 cifras). Se dejó como control.
4. ⁽⁴⁾ En `main` la Systel gana siempre, así que E08 andaba. El riesgo era de la regla nueva ("ante la duda,
   preguntar"), y el commit 19e0189 lo evita. Se dejó como control.

## Lo que esta prueba NO prueba

- Balanzas de verdad: todo es con balanzas simuladas a partir de tramas y registros reales.
- La base de datos (migraciones 220–227) ni el programa Scale Connect.
- El interruptor `balanzas_v2` (perfil por balanza): queda apagado, como está hoy para los clientes.
