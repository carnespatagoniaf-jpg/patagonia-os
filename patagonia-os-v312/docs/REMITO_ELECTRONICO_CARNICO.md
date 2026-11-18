# Remito Electrónico Cárnico (ARCA, wsremcarne)

Construido el 2026-11-17 para Della Finca (CARNES BOTS S.A., CUIT 30-71956038-1,
punto de emisión 00020 dado de alta para "Remito Electrónico Web Services").
**NO publicado. NO probado todavía contra ARCA con un certificado** (ver "Falta").

## Fuentes

- Manual para el Desarrollador WSREMCARNE v3.6:
  https://www.arca.gob.ar/ws/remitoElecCarnico/Manual_Desarrollador_WSREMCARNE_v3_6.pdf
- WSDL de homologación (`https://fwshomo.afip.gov.ar/wsremcarne/RemCarneService?wsdl`) y de
  producción (`https://serviciosjava.afip.gob.ar/wsremcarne/RemCarneService?wsdl`), bajados el
  2026-11-17: son iguales salvo la dirección. El orden de los campos sale de ahí.
- `dummy` respondió OK en los dos ambientes el 2026-11-17 (sin autenticación).

## Qué régimen corresponde

| Documento | Para qué | Cómo se autoriza | En Patagonia |
|---|---|---|---|
| Remito electrónico cárnico (comprobante 995) | Carne y subproductos de la faena de **bovinos y porcinos** (tablas 1–13 del manual: medias reses, cortes, menudencias, vísceras, grasas, huesos, porcinos) | Cada remito se pide a ARCA por web service; ARCA devuelve número, código de autorización (CRE), vencimiento y QR | **Esto** (migración 202) |
| Remito R con CAI (código 91) | El resto de la mercadería (pollo, almacén, etc.) | CAI de autoimpresor cargado a mano | Migración 147, sin cambios |
| Remito interno / traslado | Papel interno | Ninguna | Sin cambios |

El manual no nombra la resolución general ni dice quién está obligado: eso lo tiene que confirmar el
contador. Lo que el manual SÍ exige para emitir (y por eso el punto de venta solo no alcanza):

1. Punto de emisión dado de alta para "Remito Electrónico Web Services", asociado a un domicilio
   **comercial** del Sistema Registral (es el domicilio de origen). ✅ Della Finca lo tiene (00020).
2. Certificado digital con la relación al web service de carne (servicio `wsremcarne` en el WSAA).
   Della Finca ya tiene certificado propio para facturar; falta darle también esta relación.
3. CUIT activa, sin limitaciones y sin problemas de domicilio fiscal (errores 100/101/102).
4. Una **categoría de emisor** válida para esa CUIT (`categoriaEmisor`, obligatoria salvo
   redestino). Los códigos no están en el manual: se piden con `consultarTiposCategoriaEmisor`.
   Si la CUIT no tiene la categoría/inscripción que ARCA espera, ARCA rechaza el remito.
5. Para cada destinatario: CUIT, categoría de receptor y código de domicilio (`consultarCodigosDomicilio`,
   0 = domicilio fiscal). Los depósitos propios de destino tienen que estar declarados como
   domicilios comerciales.

## Cómo funciona

- Emisor = titular de la mercadería, desde el domicilio del punto de emisión → ARCA lo deja
  **emitido** en `generarRemito` (manual 2.5.2). Los casos con depositario o con titular distinto
  quedan "generado" y piden autorización de otro (no se ofrecen todavía en la pantalla).
- Movimientos: Envío (a cliente MI o a depósito propio EM), Retiro en planta, Reparto. Redestino no.
- `idReq` = AAAAMMDD + 5 cifras, único por punto de emisión. Sin respuesta → estado `incierto`; el
  reintento hace `consultarRemito` por idReq + punto antes de volver a mandar (y si vuelve a mandar, es
  con el mismo idReq, que ARCA usa para no duplicar — manual 1.6).
- Doble clic: `create_rec_remito` es idempotente por `client_id` del formulario; la función "toma" el
  remito (`claimed_at`) para que dos pestañas no lo manden a la vez.
- Todo pedido/respuesta queda en `rec_arca_calls` (sin token ni firma).
- Ticket del WSAA propio (`service = 'wsremcarne'`): no comparte ni traba el de facturación.
- Homologación vs producción: el mismo secreto `ARCA_ENV` de `arca-invoice` (staging = homo).
  Cada remito guarda `env`, y el impreso de homologación dice "PRUEBA: sin validez".

Archivos: `supabase/migrations/202_remito_electronico_carnico.sql`, `tests/sql/202_…`,
`supabase/functions/arca-remito/` (`remcarne.ts` puro + `index.ts`), web en
`apps/web/src/features/invoicing/` (`RecPanel.tsx`, `RecPaper.tsx`, `rec-logic.ts`, `rec-service.ts`,
tests `rec-logic.test.ts` y `arca-remcarne.test.ts`). `arca-invoice` no se tocó.

## Probado

- Armado y lectura de mensajes contra los ejemplos del manual y el WSDL (tests).
- Migración + prueba SQL en staging dentro de una transacción deshecha (2026-11-17): doble clic,
  idReq correlativo, reglas del manual, cajera sin permiso, contador solo lectura, otra empresa no ve
  nada, plan Estándar sin acceso.

## Prueba real en producción (Della Finca, 2026-11-17/18)

- El certificado propio de Della Finca obtuvo el ticket del WSAA para `wsremcarne` (la relación
  con el computador fiscal "patagonia" funciona). El ticket de facturación (`wsfe`) no se tocó.
- ARCA respondió las consultas: categorías de emisor (1 Frigorífico/Establecimiento Faenador,
  2 Usuario Faena, 3 Abastecedor, 4 Despostador, 5 Consignatario Cárnico, 6 Consignatario Directo,
  7 Cámara de frío/Depósito), de receptor (las mismas + 8 Carnicero, 9 Restaurantes/parrillas y
  otros receptores finales), estados, grupos de carne y los domicilios del CUIT (1 Chacabuco 480,
  2 Obispo Trejo 1096, 0 fiscal Juan del Risco y Alvarado 3427).
- `consultarPuntosEmision` → 1500 "No se han encontrado datos" y el punto 20 → 4010. La constancia
  del 00020 muestra **domicilio FISCAL**; el manual pide un domicilio **comercial**. La mercadería sale
  de Juan del Risco y Alvarado 3427: hay que declarar esa dirección también como domicilio comercial
  en el Sistema Registral y asociarle el punto (o dar de alta otro punto con ese domicilio).
- La actividad del punto es "venta al por menor de carnes rojas" y "Carnicero" solo existe como
  categoría de receptor: el contador tiene que confirmar en qué categoría de emisor está registrada.

## Diagnóstico con pedidos rechazados a propósito (2026-11-18, OK del dueño)

`generarRemito` en producción con fecha de viaje de ayer (error 140 seguro: no puede emitirse). Resultado R, nada emitido:
- 1º intento, depósito propio (EM) con CUIT del receptor: **1312** "No se debe informar la CUIT del receptor".
  Era un error de Patagonia: corregido en la migración 203 + `rec-logic.ts` + `arca-remito`.
- 2º intento sin ese CUIT: **2502** "El punto de emisión indicado no existe para el sistema que quiere utilizar,
  o no tiene asociado un domicilio comercial declarado en el Sistema Registral", y 140 (la fecha, esperado).
- Conclusión: el punto 00020 con domicilio fiscal no sirve para wsremcarne. Certificado y autorización, bien.

## Falta (en orden)

1. **Homologación de ARCA**: autorizar el certificado de prueba de Patagonia (CUIT 27-18244890-2,
   empresa de prueba Don Julio en staging) para `wsremcarne` en WSASS (lo hace el dueño con su clave
   fiscal). Aplicar la 202 en staging y desplegar `arca-remito` en staging. Probar: conexión,
   categorías, un envío a cliente, uno a depósito propio, rechazo por tropa, reintento sin respuesta,
   impresión con QR.
2. Con lo anterior OK: confirmar con el contador de Della Finca la categoría de emisor y que el régimen
   les corresponde; darle al certificado de Della Finca la relación con el servicio en su ARCA.
3. Publicar (migración + función + web) y que Della Finca pruebe "Probar conexión" en producción
   **sin emitir** remitos de prueba (en producción no hay remitos de prueba).
4. No construido: redestino, depositario/titular distinto (autorizar), recepción por el receptor,
   contingencias, modificar viaje, remito con importe (COT ARBA), receptor sin CUIT (no categorizado),
   enganchar con "Mercadería entre locales" para que el despacho emita el remito solo.
