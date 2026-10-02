# Kretz Aura: informe técnico de la integración (2026-10-02)

**Fuentes:**

- Las tramas reales de la Aura de "Pollo y mar" (AUI-030KMFBAPP4KAR, firmware V1.00 6Feb24), registradas en `scale_support_reports`.
- 5 escrituras reales con 2005.
- 2 tickets impresos.
- "Multiprotocolo para la comunicación con balanzas Report Nx", Kretz, R30 de junio de 2023 (en adelante "Nx").
- Manual de usuario Aura Eco Rev.01 (en adelante "Manual").

No se mandó nada nuevo a la balanza para este informe.

Etiquetas: **COMPROBADO** = visto en la balanza real. **DOCUMENTADO** = lo dice un documento de Kretz. **HIPÓTESIS** = no comprobado.

## 1. ¿Hace falta un comando previo para habilitar el tipo y el código?

- **DOCUMENTADO (Nx §4.27, §4.28, §4.5).** La forma de cada registro la define el "modelo de datos" del equipo: cuántos caracteres tiene cada campo, y un campo puede tener largo 0.
  - Se cambia con 2001 (cantidad de registros y de campos) y 2002 (largo de un campo).
  - Después se aplica con **1003, que FORMATEA la memoria**: borra todos los productos.
  - 1002 vuelve al modelo de fábrica y también reinicia la memoria.
- **COMPROBADO.** La Aura aceptó registros de 42 caracteres. Nx §2.7: un largo incorrecto devuelve el código 11, y la Aura devolvió 01. El modelo de datos de esta Aura para PLU es de 42 caracteres.
- **HIPÓTESIS.** Si el tipo o el código no forman parte del modelo de escritura de la Aura, "habilitarlos" exigiría 2002 + 1003. Eso **borraría los productos de la clienta**. No es una alternativa aceptable, y no se sabe si la Aura tiene esos comandos.
- **No hay en Nx ningún comando del tipo "habilitar campo"** que no pase por formatear.

**Conclusión:** no existe un comando previo documentado, seguro y no destructivo para habilitar el tipo y el código.

## 2. Diferencias entre Nx y la Aura

| Punto | Report Nx (documentado) | Aura real (comprobado) |
|---|---|---|
| Letra de equipo | C | H |
| Trama y checksum | STX…EOT, suma + 0x30 | Iguales: todas las respuestas tienen checksum válido |
| 0001 (test con sonido) | Existe | Contesta 01 |
| 0002 (test sin sonido) | Existe | Contesta 02 ("comando inexistente") |
| 1500 (datos técnicos) | Código SAP 20 + firmware 5 + libre 20 | "AUI-030KMFBAPP4KAR  " (20) + "V1.00" (5) + 18: la misma estructura |
| 5002 (largo de campo) | Datos = entidad (2) + campo (2) | Se mandó solo "05" y contestó 02. No se probó con el formato correcto |
| PLU (2005/5005) | 135 caracteres en la Report LT de Carnes Patagonia; 21 campos | 42 caracteres: 6+16+1+6+6+4+3 |
| Tipo de PLU | P, N, R | Lee P, N, D, C. **Escribe siempre D** |
| Código | 5 caracteres, antes del tipo | Lee 6 dígitos (= PLU × 10), después de la letra. **Escribe siempre 0** |
| Fin de la lista con 5005 | 40 = no existen registros | 40 |
| Respuesta a 2005 | grupo = entidad (05), código 01 | grupo 05, código 01 |
| Lectura y escritura | §4.85: 5005 usa los mismos campos que 2005 | Nombre, precio, tara y validez se escriben y se leen en las mismas posiciones |

**Lo que explica la pérdida (HIPÓTESIS, las dos que sobreviven al simulador `kretz/aura-hypotheses.ts`):**

- **H3: la Aura no toma el tipo ni el código por 2005.**
  - Pone sus valores por defecto: D (por kilo) y 0.
  - Es coherente con Nx §4.85 (mismo formato en las dos direcciones).
  - Es coherente con que el Manual solo prevé cargar el tipo (PESA Sí/No) y el código desde el teclado o con iTegra.
- **H2: al escribir, esas posiciones van en el orden de Nx (código y después tipo).**
  - Explica las 5 escrituras, pero contradice Nx §4.85.
- **Otro dato (HIPÓTESIS):** con el orden de Nx y largos 0, los 6 dígitos que siguen a la letra coincidirían con el campo "valor fijo" de Nx, y no con "código".
  - Que valga siempre PLU × 10 sugiere que lo calcula la balanza o iTegra.
  - Si es así, ningún valor que se mande en esa posición se conservaría.

**Las descartadas, y por qué** (COMPROBADO contra las 5 escrituras):

| Hipótesis | Por qué se descarta |
|---|---|
| Guardar tal cual | Nunca quedó lo mandado |
| La letra sale de la validez | "PRUEBA KILO" tenía 2 días y quedó D |
| La letra sale del código | N quedó D, no C |

## 3. ¿Qué otras lecturas nos darían información?

Todas son de **solo lectura** según Nx y caen en el rango que el código ya permite (1500–1999 y 5000–5999). **No se mandaron.**

| Comando | Qué devolvería | Para qué sirve |
|---|---|---|
| 5002 con datos "05" + "01".."21" | Largo de cada campo del PLU | **El dato que falta**: el modelo real de la Aura. Si es 0, ese campo no existe al escribir |
| 5001 con "05" | Cantidad de registros y de campos del PLU | Confirmar cuántos campos tiene el modelo |
| 1503 / 1504 "05" | Memoria y capacidad real de PLU | Diagnóstico |
| 5026 | Moneda, símbolo y decimales | Confirmar la escala del precio (hoy: pesos enteros, comprobado en pantalla) |
| 1524 | PLU, peso, precio, importe y unidades en pantalla | Saber si un PLU se vende por unidad sin mirar la balanza |
| 1501 | Número de serie | Identificación |

**Excluido:** 5008 (totales por PLU). Para leer el siguiente total hay que **borrarlo** con 3008, y eso destruiría los totales de la clienta.

## 4. ¿Hay una forma documentada de cambiar solo el precio?

- **DOCUMENTADO:** **no.** El índice completo de Nx no tiene ningún comando de "cambio de precio": solo 2005 con el registro entero. 1524 lee el precio en pantalla, pero no lo escribe.
- **COMPROBADO:** reescribir el registro conserva el nombre, el precio, la tara y la validez, pero el tipo pasa a D y el código a 0.
- **Consecuencia:** cualquier cambio de precio por cable hoy hace perder el código. En los P cambia la letra, y en los N y C cambia la forma de venta.

## 5. Comandos 1070 y 1080: ¿son compatibles con la Aura?

**1070** (configuración del código de barras, Nx §4.17). Campos: inicio pesable (2), peso o importe (1), inicio no pesable (2), unidades o importe (1) y formato (1).

- **DOCUMENTADO.** Corresponde campo por campo al menú de la Aura (Manual §7.1.7): Ini_P, PESO, Ini_U, Unid y FORM.
- **DOCUMENTADO, y es una diferencia:** la lista de formatos no coincide.

  | | Formatos |
  |---|---|
  | Nx | 1=2-5-5, 2=2-4-6, 3=1-5-6, 4=2-6-4, 5=2-3-7, 6=1-4-7 |
  | Aura (menú) | 1-4-7, 1-5-6, **1-6-5**, 2-3-7, 2-4-6, 2-5-5, PERSONALIZADO, NO. **No tiene 2-6-4** |

  Mandar 1070 con la numeración de Nx podría dejar otro formato.
- **Sin comprobar:** no se sabe si la Aura implementa 1070, ni que exista un comando para leer la configuración actual. Nx no tiene una lectura de 1070.
- **Veredicto:** **no compatible con certeza. NO enviarlo.** Lo mismo se configura desde el menú de la balanza (Manual §7.1.7), donde cada opción está documentada y se puede volver atrás.

**1080** (código individual por PLU en el ticket de suma, Nx §4.18).

- **DOCUMENTADO:** existe en Nx. El campo dice "Vendedores", que parece un error del documento.
- **El Manual de la Aura no tiene esa opción** en ningún menú.
- **Veredicto:** probablemente no esté en la Aura. **No enviarlo.**

## 6. Código de barras de los tickets

- **COMPROBADO:** los dos tickets (con $1394 y $1130) traen `2099998000008`, un EAN-13 válido.
- **HIPÓTESIS fuerte (Manual + un caso de terceros en otra Aura):** se lee como formato 2-5-5. Inicio "20", **código suma 99998** (fijo para todo ticket de venta) y valor "00000". La balanza tiene PESO = SÍ, y un ticket de suma no tiene "peso", entonces el valor sale en 0.
- **DOCUMENTADO (Manual §7.1.7, ítem PESO):** con **PESO = NO** el valor pasa a ser el **importe**. En el caso de terceros con la Aura, el importe sí aparecía.
- **Límite (DOCUMENTADO):** el ticket de suma nunca dice qué productos tiene, solo el total.

## 7. Alternativas que se pueden implementar sin poner en riesgo sus productos

| # | Alternativa | Riesgo para los productos | Evidencia | Estado |
|---|---|---|---|---|
| A | **Comparar los precios de la balanza con los de Patagonia** (solo lectura): lista de "precio desactualizado" para cargarlos a mano en la balanza | Ninguno: no escribe | La lectura completa está COMPROBADA (6 de 6, checksum OK) | Se puede hacer con lo que ya existe |
| B | **Mostrador lee el total del ticket**, después de que la clienta ponga PESO = NO en el menú de la balanza | Ninguno sobre los productos. Es una opción de menú, y se vuelve atrás | Manual + terceros. Falta 1 ticket real para calibrar los decimales | Lector armado en el simulador (`aura-barcode.ts`), sin publicar |
| C | **Lectura del modelo de datos** (5002 con el formato correcto, 5001, 5026) | Ninguno: son lecturas documentadas | Nx §4.81, §4.82, §4.91 | Requiere un "Probar todo" en el comercio. Es la única forma de confirmar H2 o H3 sin escribir |
| D | **Captura de lo que manda iTegra** al cargar un producto por unidad con código | Ninguno: lo hace el programa de Kretz | Es la referencia real | Requiere iTegra en una PC con la Aura |
| E | **Precios por cable solo para productos D (por kilo) y nuevos por kilo** | **Pierden el código** (queda en 0). Los P cambiarían a D, y por eso se excluyen | COMPROBADO en 5 escrituras | Plan armado (`aura-sync-plan.ts`), sin publicar. Solo con decisión del dueño |

**No se recomienda:**

- 1070 / 1080;
- 2001 / 2002 / 1003 / 1002, que formatean o reinician el modelo;
- 3005 o 4005 (borrar);
- 5008 + 3008 (borra los totales);
- cualquier otra escritura de prueba en la balanza de la clienta.

**Para enviar productos por unidad conservando su código:** hoy no hay ninguna alternativa respaldada por evidencia. Las únicas vías para conseguirla sin Kretz son C (si el modelo de datos muestra el campo) y D.

**Pruebas automáticas (simulador):** demuestran que el código se comporta como se espera ante las respuestas reales grabadas. **No demuestran** que la balanza vaya a aceptar algo nuevo.

## 8. Opción C preparada: diagnóstico del modelo de datos (2026-10-03, sin publicar)

**El comando.** 5002, "Lectura del largo de campo" (Nx §4.82).

- **Pedido.** Datos = entidad "05" + número de campo "01".."22".
  - El documento no muestra un ejemplo del pedido: solo dice "campo especificado de una Entidad".
  - Este formato es el que funcionó en la **Report LT real** (sesión de sept. 2026): las 22 respuestas fueron "05NN" + ancho, y daban 135 en total.
- **Respuesta (DOCUMENTADO).** Entidad (2) + campo (2) + cantidad de caracteres (3). Un campo deshabilitado responde "000" (REAL, Report LT).
- **Códigos posibles (Nx §2.7).** 01 OK · 02 comando inexistente · 10 checksum · 11 cantidad de bytes incorrecta · 20 registro inexistente · 60 error al ejecutar.

**¿Está documentado para la Aura?** **No.** Solo para la Report Nx, y comprobado en la Report LT.

**Lo que ya está registrado de la Aura** (COMPROBADO, 2026-10-02):

- 5002 con datos "05" (pedido incompleto) → `07 48 30 31 30 30 30 32 37 32 04`, o sea grupo "00", código "02".
- 0002, que la Aura no tiene → **exactamente la misma respuesta**.
- Cuando la Aura reconoce un comando de productos, contesta con grupo "05" (por ejemplo, a 2005 y 5005). Si 5002 existiera y lo único mal fueran los datos, lo esperable según Nx sería grupo 05 y código 11.
- **HIPÓTESIS fuerte:** la Aura **no tiene** el 5002. No es concluyente porque el pedido estaba incompleto.

**La herramienta** (`kretz/aura-model-probe.ts` + `aura-model-probe.test.ts`; botón "Leer modelo de datos" en el panel de la Aura; sin publicar):

- Solo manda 0001, 1500, 5001 "05", 5026 y 5002 "05NN". Un candado bloquea todo lo demás: 5008, 3xxx, 4xxx, 2xxx y la configuración 1000–1499.
- Si el campo 01 contesta "02", no insiste: un solo pedido.
- Guarda cada respuesta en hexadecimal y en texto, y la manda sola a soporte.
- **Informe automático (`analyzeModelProbe`)** con uno de estos resultados:
  - "modelo no disponible": falta la captura de iTegra;
  - "el código no existe en el registro": 2005 no puede escribirlo, y se indica dónde está el tipo;
  - "código y tipo existen": se indica en qué orden (H2) o si es un problema de validación;
  - "modelo no coincide".
- **Probado con el simulador:**
  - la respuesta real de la Aura;
  - dos modelos posibles (sin código; código antes del tipo);
  - el modelo real de la Report LT (135, detectado como no coincidente);
  - el candado.

**Qué falta para cerrar la integración:**

1. Que la Aura conteste 5002 con el pedido correcto. Hace falta **un** "Leer modelo de datos" en el comercio: es solo lectura. Si contesta "02" otra vez, el comando no existe en la Aura y por lectura no hay más que sacar.
2. En ese caso, o si el modelo muestra que el tipo existe pero se valida: **qué bytes manda iTegra** al cargar un producto por unidad con código. Es la única referencia real que queda sin Kretz.
3. Para los tickets: **un** ticket real con PESO = NO, para calibrar los decimales del importe.
