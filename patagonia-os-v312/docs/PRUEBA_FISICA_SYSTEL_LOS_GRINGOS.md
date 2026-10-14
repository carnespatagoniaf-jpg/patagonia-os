# Prueba física mínima: Systel Cuora Max de Los gringos

14/10/2026. **Preparada, NO ejecutada.** No se escribe nada en la balanza sin autorización del dueño.

## Qué hay que comprobar con la balanza real (lo único que no se puede probar sin ella)

1. Que la balanza imprima, debajo de cada artículo, un código con producto + cantidad.
2. Cómo codifica las **unidades** (¿"000001" o "001000"?). No está documentado; Patagonia acepta las dos y rechaza cualquier otra cosa.
3. Que el lector de la caja lea esos códigos (EAN-13, empiezan con 20/21) y el del TOTAL.

El peso ya está comprobado con etiquetas reales de otro cliente Systel (gramos en "CCCCCC"). Por eso el producto de la prueba es **uno por unidad**.

## Configuración que hace falta en la balanza (manual Cuora Max)

**Ruta recomendada: el menú de la balanza.** Es la vía documentada. Así se hicieron los 4 productos que ya tienen código propio (13, 14, 50 y 51, gestión 0 = "hecho en la balanza").

- **Por producto:** Menú → *4. Artículos* → *2. Editar/Crear PLU* → N.º de PLU. Se pasa por cada dato con la tecla de aceptar **sin cambiar nada** hasta la opción del código de barras: *1. USAR EAN GRAL. / 2. CONFIGURAR EAN / 3. NO USAR EAN*. Ahí se elige *2. CONFIGURAR EAN* y se escribe:
  - producto **por unidad**: `21PPPPCCCCCC`;
  - producto **por peso**: `20PPPPCCCCCC` (6 cifras de cantidad = hasta 999,999 kg; hoy el general tiene 4 = hasta 9,999 kg, y 57 ventas reales de la semana pasaron los 10 kg).
- **No hace falta tocar** el código del TOTAL (`22AAIIIIIIII`, real) ni "Imprime código EAN en tickets" (ETi=S, real).
- Pide la clave de administrador de la balanza (la tiene el cliente).

**Alternativa desde la PC** (función 61, herramienta "Probar en este producto" de Stock → Balanza):
- Ya está preparada, con respaldo, verificación y restauración, y está **deshabilitada**.
- Tiene 3 dudas que el documento de Systel no resuelve:
  - no se sabe si pone en cero los totales de venta de ese producto en la balanza;
  - no se sabe si el tipo de código va como dígito o como byte;
  - no se sabe si el mensaje lleva byte de control.
- Recomendación: usar el menú para la prueba. Para los 87 productos, decidir después de la prueba: a mano por menú (≈ 1 a 1,5 h) o la herramienta, probándola antes en 1 producto.

## Fase A: sin publicar nada (solo la balanza y el lector)

| Quién | Qué | Tiempo |
|---|---|---|
| Nosotros | Nada que instalar. Tenemos el respaldo del producto 2 (registro 62 real del 14/10: código propio tipo 1 = `000000000000`) | — |
| Cliente | En el menú de la balanza, el **producto 2 (GRINGO CAJÓN)**: *CONFIGURAR EAN* → `21PPPPCCCCCC`. No cambiar ningún otro dato | 3–5 min |
| Cliente | En la **próxima venta real** de un cajón (no hace falta una venta de prueba): mirar el ticket. Debajo del cajón tiene que aparecer un código que empiece con 21 | 0 min extra |
| Cliente | Abrir el **Bloc de notas** de la PC, escanear el código de debajo del cajón y el del TOTAL, y mandar ese texto + una foto del ticket | 2 min |
| Nosotros | Leer esos códigos con el mismo programa de Mostrador (`decodeScaleCode`) y comparar con la foto: producto 2, cantidad, TOTAL e importe | 10 min |

Si en ese mismo ticket hay una **pechuga S/H x1x3 (producto 13)**, que ya tiene `20PPPPCCCCCC` desde antes, su código prueba también el peso, sin cambiar nada.

**Resultado esperado:** `21` + `0002` + `000001` (o `001000`) + verificador. Cualquier otra forma se analiza antes de seguir; Mostrador no carga lo que no entiende.

**Revertir (1 minuto):** mismo menú, producto 2 → *CONFIGURAR EAN* → `000000000000` (el valor original). Nada más cambió: ni precios, ni ventas, ni otros productos.

**No modifica ventas históricas:** se usa una venta real que igual iba a ocurrir. No se imprime ningún ticket de prueba, no se anula nada y no se usa la función "Cerrar ventas".

## Fase B: el primer cobro real con descuento de stock (necesita tu autorización para publicar)

Antes, de nuestro lado:
1. Aplicar la migración 119 en producción. Solo agrega 3 tablas y 4 funciones nuevas; no cambia nada existente.
2. Publicar la web. La venta "artículos + TOTAL" se activa solo en la sucursal que tenga su balanza cargada (hoy, ninguna).
3. Cargar el catálogo de su balanza con los registros reales que ya tenemos (lectura del 14/10), sin pedirle nada al cliente, y vincular los 66 que coinciden.
4. Contar el stock del producto de la prueba. Hoy **todos sus productos tienen stock 0**: sin un stock inicial, el descuento se ve como negativo.

Cliente: en Mostrador, escanear el código del cajón, después el TOTAL, y cobrar. Tarda 30 segundos.

Comprobación (nosotros, 5 min):
- `pos_sales`: 1 venta por el TOTAL del papel.
- `pos_sale_items`: el producto 2, cantidad 1, importe del papel.
- `pos_scale_paper_claims`: 1 papel.
- `inventory_movements`: −1 al producto 2, una sola vez.
- El reporte de ventas de la balanza (función 72, solo lectura) tiene el mismo ticket.

**Revertir:**
- **la venta:** "Anular" en Mostrador (devuelve el stock);
- **la función:** borrar la fila de `scale_profiles` de la sucursal (Mostrador vuelve a funcionar como hoy al instante, sin publicar);
- **la web:** volver a publicar la versión anterior en Netlify (hoy 6acf9a463852339c62eabc67);
- **la balanza:** como en la Fase A.
