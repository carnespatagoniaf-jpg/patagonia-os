# 1. Instalar Patagonia Scale Connect y vincularlo (PRUEBAS)

Esta versión se conecta al **Patagonia de pruebas** (staging), no al de los clientes. Todo lo que hagas acá queda en la empresa demo **"Carnicería La Estancia (DEMO)"**, en el local **Barrio Norte**.

Todo lo que se usa está en la carpeta **`Documentos\Pruebas balanzas`**.

## Antes de empezar

- Usá la computadora donde vas a enchufar las balanzas, con internet.
- Cerrá iTegra (Kretz) y Qendra (Systel) si están abiertos: si tienen tomada la balanza, Patagonia no la puede usar.
- Tené a mano el usuario del demo: está en `demo-comercial\demo\ACCESO_DEMO.env` (`DEMO_EMAIL` y `DEMO_PASSWORD`).

## Paso 1. Instalar

1. Doble clic en **`1. Instalar Scale Connect (PRUEBAS).bat`**.
2. Windows va a preguntar si permitís que haga cambios: tocá **Sí**.
   - El instalador todavía no está firmado: si aparece "Windows protegió tu PC", tocá **Más información → Ejecutar de todas formas**. Con los clientes esto se va a ir cuando esté el certificado.
3. Al terminar, se abre solo el navegador en `http://127.0.0.1:9120/vincular`. Dejalo abierto.

**Comprobación:** en el menú Inicio, buscá "Servicios", abrilo y buscá **Patagonia Scale Connect**: tiene que decir *En ejecución* y *Automático (inicio retrasado)*.

## Paso 2. Abrir Patagonia de pruebas

1. Doble clic en **`2. Abrir Patagonia (PRUEBAS).bat`**. Se abre una ventana negra (no la cierres mientras probás) y, al rato, el navegador en `http://localhost:3010`.
2. Entrá con el usuario del demo.
3. Arriba a la izquierda elegí el local **Barrio Norte**.

## Paso 3. Vincular la computadora

1. En Patagonia: **Stock → botón "Balanza"** (arriba a la derecha) → **Mis balanzas**.
2. En el bloque **"Computadoras con Scale Connect"**, tocá **"Agregar esta computadora"**. Aparece un código de 8 letras (vale 10 minutos).
3. En la pestaña de `127.0.0.1:9120/vincular`:
   - escribí el código;
   - poné un nombre para la PC, por ejemplo **"Caja 1"**;
   - tocá **Vincular**. La página dice en rojo que es el sistema **de pruebas**: está bien.
4. Volvé a Patagonia. En menos de un minuto, "Caja 1" aparece **En línea**.

## Paso 4. Agregar la balanza

1. Enchufá la balanza (USB, cable serie o red) y prendela.
2. En Mis balanzas: **Agregar balanza → En esta computadora con Scale Connect**.
3. Patagonia busca sola y muestra lo que encontró (marca, modelo y por dónde está conectada). Tocá **Agregar esta**.
   - **Balanza por red que no aparece:** escribí la dirección que muestra la balanza en su menú de red y tocá **Buscar en esa dirección**.
   - Si pregunta **"¿Es la …?"**, contestá según corresponda. Es para no registrar dos veces la misma balanza.
4. Ponele un nombre (por ejemplo "Mostrador").

## Paso 5. Enviar los productos

1. En la tarjeta de la balanza, tocá **Enviar productos**.
2. Leé la revisión previa: dice qué productos no van y por qué (nombre largo, precio con centavos, etc.).
3. Confirmá. Vas a ver el avance y al final: **"X de Y productos quedaron y se comprobaron en la balanza"**.

## Si algo falla

Doble clic en **`Diagnostico balanzas.bat`** (pide permiso de administrador). Deja un `.zip` en el Escritorio con todo lo técnico, sin claves. Avisame y lo leo de ahí.

Además, en Mis balanzas, el botón **"Enviar a soporte"** manda el detalle de la pantalla al soporte de pruebas, donde también lo veo.
