# 2. Pruebas físicas por marca y modelo

**Dónde:** Patagonia de pruebas, demo "La Estancia", local **Barrio Norte**. `balanzas_v2` está prendido en el demo, así que cada balanza usa su propio perfil de etiqueta.
**Qué se manda:** el demo tiene 99 productos por kilo y 51 por unidad, con códigos del 1 al 999, precios de hasta $84.900 y nombres de hasta 27 letras.
**Cómo anotar:** marcá cada casilla ✅ o ❌. Si algo da ❌, corré `Diagnostico balanzas.bat` antes de tocar nada y avisame.

> Una integración se da por validada recién cuando pasan **A, B, C y D** de ese modelo.

## Pruebas comunes a todos los modelos

| # | Prueba | Cómo | Resultado esperado |
|---|---|---|---|
| A1 | Detecta la balanza | Agregar balanza → En esta computadora con Scale Connect | Aparece con la marca y el modelo correctos y por dónde está conectada |
| A2 | No duplica | Repetir A1 con la misma balanza | Dice "Ya está agregada" o pregunta "¿Es la …?" |
| B1 | Envío completo | Enviar productos | "X de Y quedaron y se comprobaron". X = los que la revisión previa dejó pasar |
| B2 | Conteo correcto | Mirar en la balanza 3 productos al azar | Nombre (puede estar acortado), PLU y precio iguales a Stock |
| B3 | Segundo envío | Enviar productos otra vez sin cambiar nada | Dice que ya está igual, o confirma sin cambios. No reescribe todo |
| B4 | Cambio de precio | Cambiar en Stock el precio de 2 productos → Enviar | Solo esos 2 cambian en la balanza |
| C1 | Etiqueta por kilo | Pesar algo de un producto por kilo e imprimir | La etiqueta trae código de barras |
| C2 | Prueba de etiqueta | Mis balanzas → Probar → escanear la etiqueta de C1 | "Etiqueta probada": producto y kilos correctos |
| C3 | Etiqueta por unidad | Imprimir un producto por unidad | Trae código de barras |
| D1 | Cobro en Mostrador | Escanear las etiquetas de C1 y C3 → Cobrar | Producto, kilos e importe iguales al papel |
| D2 | Stock | Stock → mirar esos 2 productos | Bajaron exactamente lo vendido |
| E1 | Desenchufar a mitad | Enviar productos y desenchufar la balanza a la mitad | Termina con "fallado" o "quedaron X de Y", **nunca** "Listo". Al reenchufar y reenviar, completa |
| E2 | Balanza apagada | Apagar la balanza → Enviar productos | Mensaje claro, sin colgarse |
| E3 | Programa de la marca abierto | Abrir iTegra o Qendra con la balanza → Enviar | Avisa que otro programa la tiene. Al cerrarlo, funciona |
| E4 | Reinicio de la PC | Reiniciar Windows **sin iniciar sesión** y esperar 2 minutos | Patagonia muestra la PC "En línea". Enviar funciona sin reconfigurar |
| E5 | Sin internet | Desconectar el internet 2 minutos durante un envío encolado | Al volver termina solo |

## Particularidades de cada modelo

### Kretz Report LT por USB o Bluetooth
- **Preparar:** por USB, enchufarla directo; por Bluetooth, emparejarla en Windows antes.
- **Qué mirar:**
  - B2: en la balanza, el producto tiene la etiqueta configurada para imprimir código.
  - C1: el código empieza con el inicio de esta balanza, normalmente **20**.

### Kretz Report LT por red y Kretz Report NX2
- **Preparar:** cable de red directo a la PC o al router; la IP de la balanza está en su menú.
- **Qué mirar:**
  - A1: si no aparece sola, buscá escribiendo la dirección.
  - C1 en la NX2: **confirmar que la etiqueta trae código de barras**. Su formato de fábrica no lo trae, y esto nunca se probó en una balanza real.

### Kretz Aura Eco (RS-232)
- **Preparar:** cable DB9 directo 1:1 con adaptador USB (FTDI o CH340). En el menú, modo **Datos**.
- **Qué mirar:**
  - B2: nombres cortados a 16 letras.
  - C1: código **2-3-7** con importe en centavos.
  - **Extra:** imprimir un ticket con 2 productos y su **TOTAL**. En Mostrador, escanear el TOTAL solo tiene que pedir **detallar el ticket**, y no deja cobrar hasta escanear los 2 productos.

### Systel Cuora Max (firmware 6.0)
- **Preparar:** USB (FTDI). Cerrar Qendra.
- **Qué mirar:**
  - B1: la primera vez crea "PRUEBA PATAGONIA" a $1 en un número libre. Es normal y se puede borrar.
  - C1: código **20 + producto 4 + gramos 6**.
  - **Extra:** anotá si la balanza tenía **totales de venta** guardados antes del envío y si siguen después.

## Prueba de dos balanzas en la misma computadora

Con dos balanzas de **marcas distintas** enchufadas a la misma PC (por ejemplo Report por USB y Cuora Max por USB):

| # | Prueba | Esperado |
|---|---|---|
| F1 | Agregar las dos | Aparecen las dos, cada una con su nombre |
| F2 | Enviar a las dos a la vez (Enviar productos en una, enseguida en la otra) | Avanzan las dos en paralelo y terminan bien |
| F3 | Repetir F2 y **desenchufar una** a mitad | La desenchufada termina fallada o parcial, **nunca** "Listo". La otra termina **bien** |
| F4 | Inicios distintos | Las etiquetas de cada una empiezan distinto (por ejemplo 20 y 22/23). Anotar cuál usa cada una |
| F5 | Cobro mezclado | Escanear en una misma venta 2 etiquetas de cada balanza | Cada una con su producto, kilos e importe. Si alguna pregunta "¿cuál es?", anotarlo |
| F6 | Stock | Bajó lo vendido de las cuatro etiquetas |

## Qué mandarme al terminar

- Esta tabla completa, con ✅ o ❌.
- Una foto de cada etiqueta impresa (C1 y C3 de cada modelo).
- El `.zip` del diagnóstico de cualquier prueba ❌.

Con eso confirmo cada modelo como **validado con hardware real**, corrijo lo que haya fallado y pasamos a elegir los clientes piloto.
