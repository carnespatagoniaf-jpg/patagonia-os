# Arranque de un chat nuevo (actualizado 2026-10-08)

Lo que NO hace falta pegar, porque el chat nuevo lo lee solo:
- `CLAUDE.md`: cómo está armado el sistema, el deploy, las reglas de kilos y plata, la Aura, Systel, etc.
- La memoria de Claude: tus preferencias, los clientes, lo que ya está publicado.

## Mensaje para pegar al empezar

```
Hola. Respondeme siempre en castellano. Lo que quedó pendiente está en docs/ARRANQUE_NUEVO_CHAT.md, leelo antes de arrancar. Hoy quiero: <lo que necesites>
```

## Estado al 2026-10-08

**Último cambio publicado (2026-10-08):** "Presentaciones" en Stock (migración 111). La misma mercadería con varios precios (oferta 3 kg, mayorista, cajón x15) usa el stock de un producto principal. Pedido por un cliente mayorista/minorista (probablemente Los gringos). El cliente todavía tiene que vincular sus ofertas y ajustar el stock de los principales con un conteo.

**Cambio anterior (commit eff45f6):** los kilos que se escriben a mano ya no dejan el "0" al borrar y aceptan coma. Vale para Mostrador, Clientes, Compras, Ajustar stock, Sucursales, Despiece, Recetas y el control de balanza.

**Pendientes:**
1. **Aura de "Pollo y mar": código de barras.**
   - Qué falta: la clienta tiene que tocar "Ajustar el código de barras de la balanza" en cada una de sus 2 Aura, en Productos → Balanza por cable → Aura.
   - Lo que se sabe: una de las dos balanzas ya lo aceptó.
   - Mostrador YA lee bien los tickets de total: el 2026-10-06 se cobraron 5 tickets escaneados, de hasta $39.651. Eso confirma que el formato 2-3-7 (1070 "2002005", con la numeración del Multiprotocolo Nx) quedó en la balanza.
   - Pedido nuevo (2026-10-08): la clienta quiere ver productos y kilos, no solo el total. PUBLICADO el botón "4. Código de barras por producto en el ticket" (comando 1080, commit e26f5d0). Falta su única prueba en el local. El resultado llega solo a soporte: revisarlo en `scale_support_reports` antes de pedirle nada.
   - Regla: no pedirle más pruebas a la clienta. Si algo falla, debería llegar un reporte de soporte.
2. **Multisucursal, etapas 2 a 5.**
   - La etapa 1 (la auditoría) está hecha: `docs/AUDITORIA_MULTISUCURSAL.md`.
   - Antes de tocar nada falta tu OK y tres decisiones: la sucursal en las liquidaciones de sueldo, las 8 funciones que no validan la sucursal, y los listados que mezclan sucursales.
   - Se trabaja en staging, con la empresa ficticia "Carnicería Don Julio". Nunca sobre datos de clientes.
3. **Balanzas Systel (en pausa desde el 2026-10-10, esperando una Cuora Max DE PRUEBA).**
   - **Producción (2026-10-13, 14:00 UTC):** Netlify `6ace395aaf6313a790a8c50f` = rama `publicado-2026-10-13` (`294d9d9` + ticket de total Systel + circuito etiqueta→venta→stock). En main esos arreglos son `bddc306`, `e969cc1`, `b504612`. Lo pendiente de Systel (`45e2214`…`fd79e0c`) NO está publicado.
   - **Guardado y sin publicar:** commits `45e2214` a `8e67e64` y el de este cierre. No publicar sin OK del dueño.
   - **Diagnóstico completo:** `docs/SYSTEL_DIAGNOSTICO_LOS_GRINGOS.md`. Los pasos para la balanza de prueba están en la sección J y en `tools/laboratorio-systel/LEEME.txt`.
   - **Paquete del laboratorio:** `laboratorio-systel-<commit>.zip`, en la carpeta de arriba del repo (fuera de git). Cómo rearmarlo: `tools/laboratorio-systel/ARMAR-PAQUETE.md`.
   - **Para retomar:** conseguir una Cuora Max de prueba y hacer los pasos 0 y 1 (lectura + cambio de precio con restauración, 3 veces). Analizar los informes `.json` y, si dan "aprobado", agregar UN perfil "precio" con esa firma y ese formato exactos a `SYSTEL_VERIFIED_WRITE_PROFILES`. El alta se valida aparte.
   - **Reglas:** no pedirle pruebas a Los gringos, no contactar a Systel sin OK del dueño, y la secuencia ante E3 es solo una hipótesis.
4. **Publicidad.**
   - Las 8 piezas y los textos están en `docs/marketing/campana-redes-2026-10/`.
   - Lo multisucursal no se anuncia como disponible.

**Reglas que siguen valiendo:**
- No publicar nada en producción sin autorización.
- No tocar la integración Kretz Report LT.
- Nunca borrar productos de una balanza.
- No subir al repositorio `supabase/functions/admin-reset-password/`.
- Cada cambio de pantalla actualiza y vuelve a publicar la guía del chat de ayuda.

**Factura electrónica ARCA (arrancado 2026-10-08):**
- Patagonia factura por delegación: cada carnicería le delega "Facturación Electrónica" al CUIT 27-18244890-2.
- La clave privada y el pedido de certificado están en `C:\Users\g\patagonia-arca\` (fuera del repo, nunca subirla).
- El mail con la guía se le mandó a francisco.nesii@outlook.com. Falta que responda con `prueba.crt` y `real.crt`.
- Decidido: se factura solo cuando el cliente pide factura; hay que soportar monotributo (C) e inscriptos (A y B).
- Parte 1 armada el 2026-10-08. Está commiteada (b3f7513) y publicada OCULTA:
  - migración 113 (`company_fiscal_settings`, `invoices`, `save_fiscal_settings`, `request_invoice`), aplicada SOLO en staging;
  - pantalla Facturas (`features/invoicing`);
  - casilla "El cliente pide factura" en Mostrador.
- Facturas se oculta del menú fuera de staging (`SHOW_INVOICING` en `Layout.tsx`). En la guía del chat dice "TODAVÍA NO DISPONIBLE".
- Falta la parte 2: la Edge Function WSAA + WSFEv1 con los certificados, "Probar conexión con ARCA" (que es lo que prende `enabled`), el CAE y el QR en el ticket, y la nota de crédito al anular.
- PUBLICADO 2026-10-08: el ticket térmico sin factura dice "NO VÁLIDO COMO FACTURA". El control de balanza del cierre ahora lee el punto decimal de la Kretz ("962812.52") y avisa si se perdió el punto; se corrigieron 7 cierres mal guardados de Carnes Patagonia. La guía del chat con Facturas está en el repo pero NO publicada.

**Reportes → "Por categoría" (PUBLICADO 2026-10-08, migraciones 114 y 115, commit cd1b91e):**
- Vendido, kilos, ganancia y margen por categoría y producto, más "↑/↓ % vs. anterior".
- Desde el 8/10 cada venta guarda su costo (`pos_sale_items.unit_cost`, por trigger). Las ventas de antes usan el costo de hoy (estimado).
- Pendiente del dueño: Carnes Patagonia tiene 24 productos vendidos SIN COSTO (Suprema, Picada especial, Bife de chorizo, Pollo entero, milanesas, ofertas…). Son unos $19 millones en 30 días, así que su ganancia sale de más hasta cargarles el costo en Stock.
