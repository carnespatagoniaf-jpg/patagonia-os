# Facturas de proveedores por WhatsApp (etapa 2)

**Estado:** sin construir. La etapa 1 ("Leer factura con foto" en Compras, migración 195 + Edge Function `invoice-reader`) ya hace la parte difícil: leer el papel y armar la compra. La etapa 2 agrega otra forma de mandar la foto: un WhatsApp del negocio.

## Cómo funcionaría

1. El dueño le manda la foto (o el PDF) de la factura al número de WhatsApp de Patagonia OS, con un comentario opcional ("pagada en efectivo").
2. Meta llama a una Edge Function nueva (`whatsapp-webhook`) con el mensaje.
3. La función identifica la empresa por el número que escribe (tabla nueva: teléfono autorizado → empresa y usuario), baja la imagen con la API de Meta, la lee con el mismo prompt y esquema de `invoice-reader` y guarda un **borrador** de compra (tabla nueva `purchase_drafts`: empresa, sucursal, proveedor sugerido, renglones leídos, imagen, estado `pendiente`/`registrada`/`descartada`).
4. Contesta por WhatsApp: "Leí la factura de Oink por $1.007.740 (6 renglones). Confirmala acá: <link>".
5. En Compras aparece "Facturas para revisar (N)". Al abrir una, se carga en el mismo formulario de siempre (proveedor, fecha, renglones) y la persona toca "Registrar compra". Recién ahí se mueve el stock, el costo y la deuda, por `create_purchase_transaction` como siempre.

Así nada entra al stock sin que una persona lo vea, igual que en la etapa 1.

## Qué tiene que hacer el dueño (antes de programar)

- **Un número de celular nuevo**, que no esté usado en WhatsApp común ni en WhatsApp Business de la app (Meta no deja usar el mismo número en los dos lados).
- **Una cuenta de Meta Business** (business.facebook.com) verificada con los datos de Patagonia OS. La verificación tarda de unos días a un par de semanas.
- En developers.facebook.com: crear una app de tipo "Empresa", agregarle el producto **WhatsApp**, registrar el número y generar un **token permanente** (usuario del sistema con permiso `whatsapp_business_messaging`).
- Pasar: el token, el `phone_number_id` y un texto secreto para verificar el webhook. Se guardan como secretos de las Edge Functions (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`), nunca en el código.

**Costo:** recibir mensajes y contestar dentro de las 24 horas siguientes es gratis en la API de WhatsApp (conversaciones de servicio). Leer cada factura cuesta lo mismo que en la etapa 1.

## Qué hay que programar

- Migración: `whatsapp_senders` (teléfono, empresa, usuario, activo) y `purchase_drafts`, con RLS de lectura por empresa y escritura solo por RPC (regla de la migración 175).
- Edge Function `whatsapp-webhook` **sin sesión** (agregarla a `SIN_SESION` en `publicar.yml`): GET de verificación de Meta, POST que valida la firma `X-Hub-Signature-256` con el secreto de la app (si no, cualquiera podría cargar facturas), ignora números no autorizados, baja la imagen, la lee y guarda el borrador.
- Compras: lista de borradores pendientes y "Abrir" que llena el formulario (reutiliza `draftLinesFromInvoice` y `matchSupplier` de `invoice-draft.ts`).
- Mover el prompt y el esquema de `invoice-reader` a un archivo compartido (`supabase/functions/_shared/`) para que las dos funciones lean igual.
