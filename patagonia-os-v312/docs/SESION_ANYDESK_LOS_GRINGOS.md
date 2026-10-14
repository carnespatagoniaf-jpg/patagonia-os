# Sesión única por AnyDesk: Systel Cuora Max de Los gringos

**Preparada, no ejecutada.** Duración: unos 30 minutos.

**Qué toca:**
- lee la balanza;
- crea 2 productos de prueba en números libres;
- imprime 1 ticket de prueba de unos pocos pesos.

**Qué no toca:** ninguno de los productos del cliente, precios, configuración ni ventas anteriores. Producción no se publica.

## 1. ¿Podemos conectarnos en solo lectura? Sí, ya está comprobado

| Qué | Evidencia real |
|---|---|
| Conexión | USB, chip FTDI FT232R, COM3 (foto del 13/10). 115200 baudios, 8N1, balanza N.º 20 (las respuestas llegan con dirección 0x14 = 20) |
| Modelo y protocolo | Firma `F2000C030000S0060P08000A060D0`: Cuora Max, protocolo 0060, 8.000 productos, precios sin decimales, 30 kg |
| Lectura de productos (62) | 412 respuestas en la sesión del 14/10 12:53 y los 103 productos leídos completos |
| Reporte de ventas (72) | 1.430 artículos leídos el 14/10 |
| Configuración (39) y reloj (28) | Leídos (E_P=20PPPPCCCCII, E_U=21PPPPCCCCII, E_S=22AAIIIIIIII, ETi=S; reloj +11 min) |
| Usuario | 1 usuario de Los gringos, administrador, plan Estándar: puede abrir Stock → Balanza |
| Herramienta de lectura | Ya está publicada desde el 14/10 ("Diagnóstico completo (solo lectura)", "Respaldar los productos"). **Para la parte de solo lectura no hace falta publicar nada.** |
| Sin confirmar | La respuesta "no existe" (E7) a un producto inexistente: nunca se le pidió uno. Si contesta otra cosa, la herramienta frena sin escribir |
| Riesgo conocido | E3 ("ocupada") mientras algún vendedor tiene un ticket abierto: con el local cerrado no pasa (lecturas completas el 14/10 09:19 y 09:53) |

## 2. Lista exacta antes de conectarnos

**Autorizaciones (por escrito, antes del día):**
1. **Tuya:** crear un **borrador privado** de la web armado con la herramienta de escritura. Es una dirección aparte de Netlify; no reemplaza producción ni la cambia, pero la escritura en la balanza solo existe ahí.
2. **Del cliente:**
   - crear 2 productos de prueba "PRUEBA PATAGONIA" ($1) en los números 7999 y 7998, que quedan en la balanza y se pueden borrar desde su menú;
   - imprimir 1 ticket de prueba (unos pocos pesos), que queda en el historial de ventas de la balanza;
   - mirar 2 veces el total de ese producto de prueba en el menú de la balanza.

**Nuestro lado:**
3. El borrador armado con `VITE_SYSTEL_BARCODE_WRITES=1` desde la rama `balanzas-venta-staging`, del commit probado. Se valida antes de la sesión: se abre, inicia sesión, y Stock → Balanza muestra los botones.
4. A mano: la evidencia de la fase 0 (`docs/evidencia-balanzas/`) y la lectura real del 14/10 (en soporte) para comparar.
5. Quién está de cada lado: vos o yo manejando AnyDesk; del lado del cliente, una persona que inicia sesión, acepta AnyDesk, pesa e imprime el ticket.

**En el local (confirmar por mensaje el día anterior):**
6. La PC con **Chrome** actualizado, AnyDesk instalado y el ID a mano.
7. La balanza **prendida, conectada por USB** a esa PC y **con papel**.
8. El **lector de código de barras** conectado a la misma PC.
9. **Local cerrado o sin clientes, y ningún ticket abierto** en la balanza (ningún vendedor A–D con artículos sin imprimir).
10. **Ningún otro programa usando la balanza.** No tiene que haber un Mostrador de Patagonia abierto en otra pestaña (abre el puerto para leer tickets). Si tienen Qendra u otro programa de Systel, que esté cerrado.
11. El cliente sabe su **usuario y contraseña** de Patagonia: el borrador es otra dirección y pide iniciar sesión otra vez. **La contraseña la escribe el cliente, no nosotros.**
12. Sabe ver en la balanza el **total por producto** (menú de listados o totales por PLU). Si no lo sabe, se lo guiamos en el momento.

## 3. Guion de la sesión (en este orden; se frena en cualquier ✗)

| # | Qué | Quién | Tiempo | Escribe en la balanza |
|---|---|---|---|---|
| 0 | Abrir el borrador. El cliente inicia sesión. Stock → Balanza. Chrome pide el puerto la primera vez: elegir "FT232R USB UART (COM3)" | Cliente + nosotros | 3 min | No |
| 1 | **Diagnóstico completo (solo lectura)**: firma, reloj, formatos, productos, ventas. Se manda a soporte | Nosotros | 3 min | No |
| 2 | **Respaldar los productos (solo lectura)**: tiene que decir "completo y verificado" (103 o 104 productos). Después "Comparar con el respaldo": todo igual | Nosotros | 3 min | No |
| — | **Punto de corte:** si 1 o 2 no salen completos, se termina acá. Se analiza sin molestar más | — | — | — |
| 3 | Marcar la autorización y tocar **"1. Probar en números libres"**: la balanza contesta "no existe" en 7999 y 7998, se crean los 2 productos de prueba, se releen, y se verifica que los productos del cliente y su historial de ventas siguen iguales | Nosotros | 2 min | **Sí, solo 7999 y 7998** |
| 4 | **Ticket de prueba:** en la balanza, el producto 7999 con algo encima (≈1 kg) y el 7998 × 2 en el mismo ticket, e imprimir. Escanear el código de cada artículo y el del TOTAL en **"Probar un código impreso"**. Tiene que decir "PRUEBA PATAGONIA … kg" y "… 2 unidad(es)" | Cliente pesa e imprime; nosotros miramos | 5 min | No (es una venta normal de la balanza) |
| 5 | Menú de la balanza: **total del producto 7999**. Foto o anotarlo | Cliente | 2 min | No |
| 6 | **"1b. Reescribir el producto de prueba"** (solo el 7999) | Nosotros | 1 min | **Sí, solo 7999** |
| 7 | Mirar otra vez el total del 7999. **Si quedó igual, la escritura no borra acumulados. Si volvió a cero, sí los borra**, y eso lo tiene que aceptar el cliente antes de tocar sus productos | Cliente | 2 min | No |
| 8 | Comparar con el respaldo: los productos del cliente siguen iguales. Fin | Nosotros | 2 min | No |

**Qué NO se hace en esta sesión:** la prueba 2 (un producto real), los 87 productos, ni publicar en producción. Eso se decide con los resultados de 4 y 7.

## 4. Qué nos llevamos de la sesión
- Si la balanza acepta la escritura, y en qué forma (byte o dígito).
- Si imprime el código de cada artículo y el lector lo lee (peso y **unidades**: lo único que nunca vimos impreso).
- Si escribir un producto borra sus acumulados en la balanza.
- El nombre del producto 201 y el catálogo completo actualizado.
- Todo queda en los reportes de soporte, sin depender de fotos.

## 5. Si algo sale mal
- **Cualquier ✗ en 1 a 3:** no se escribió nada en los productos del cliente (cada paso lo verifica). Se corta y se analiza.
- **Corte de conexión durante el paso 3 o 6:** solo pueden quedar a medias los productos de prueba. "Comparar con el respaldo" confirma que los del cliente siguen iguales.
- **Los productos de prueba** quedan en la balanza. Se borran desde el menú de la balanza (Artículos → Eliminar PLU) o se reusan en la próxima sesión.
