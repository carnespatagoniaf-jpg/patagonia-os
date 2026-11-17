# Balanzas por cable de red (UTP / Ethernet)

"Mis balanzas → Agregar balanza → Conectar balanza por cable de red". El código está en `apps/web/src/features/scales/network/` y el programa de la PC es `apps/web/public/patagonia-print-agent.ps1`, versión 6.

## Camino corto (18/11/2026)

1. **Revisa el programa de la PC** antes de buscar. Si falta, está viejo o Chrome lo bloquea, muestra un solo botón: INSTALAR, ACTUALIZAR o RECARGAR. Después revisa cada 6 s y, apenas el programa contesta, busca solo.
2. **Busca sola** en los puertos 1001 (Kretz Report) y 10001 (Systel Cuora Max). La marca se reconoce por el puerto.
3. **UNA balanza: se conecta sola**, sin tocar nada. Sigue el camino de siempre: lee la balanza (prueba real), muestra "Listo, balanza conectada" y deja sincronizar productos.
4. **Varias:** cada una con su modelo y CONECTAR.
5. **Ninguna:** pasos de a uno, en este orden: luz del cable → balanza prendida → la IP y máscara exactas para poner en la balanza (`addressAdvice`; si el cable va directo a la PC, la red de emergencia 169.254.x.x de la PC). Busca sola cada 6 s y al tocar "YA ESTÁ". Después del último paso se puede escribir la IP a mano, y el diagnóstico va solo a soporte.
6. **Se acuerda de la balanza.** "Mis balanzas" revisa sola las balanzas por red al abrirse y cada 30 s mientras la lista está a la vista (`net-watch.ts`): muestra "Conectada por cable de red" o "No contesta".
7. **Reconexión sola** (`NetScalePort.open`). Si no contesta, reintenta 3 veces, porque la balanza puede estar prendiéndose o el cable recién puesto. Si sigue sin contestar, busca en la red en el puerto de su marca. Si aparece UNA sola balanza nueva de esa marca, es ella con otra dirección: la recuerda con la nueva (`moveNetAddress`: lista de direcciones, cable de cada balanza y balanza de "Mi balanza") y sigue. Con dos o más no adivina.

## Lo honesto

- **Ninguna balanza real se conectó todavía por red.** Ni la Kretz Report NX2 (RPF NP30P2CAR) de El Shopping de la Carne, ni ninguna otra. Todo se probó con el programa de la PC real contra balanzas simuladas.
- **La Kretz Report no lee el peso por la PC.** No hay un comando comprobado ni documentado para pedirle el peso a una Report (`models.ts`: `weight: "desconocido"`). No se inventa uno. La prueba real al conectar es leer la balanza (modelo y productos).
- **"Conectada" quiere decir que la balanza contesta en la red.** Para vender no hace falta una conexión abierta, porque Mostrador lee la etiqueta impresa. La revisión de fondo es para que "PASAR PRODUCTOS" la encuentre sin preguntar.
- **Systel Cuora Max por red:** la ruta del menú de la IP no está en los documentos que tenemos.

## 5 pruebas en el local (con la balanza real)

1. **Enchufar:** cable de la balanza al router (o a la PC), balanza prendida. Mis balanzas → Agregar balanza → "Conectar balanza por cable de red". Tiene que decir "Listo, balanza conectada" sin tocar nada más (si pide INSTALAR, instalar y esperar).
2. **Desenchufar el cable:** sacarlo 10 s y volver a ponerlo. En Mis balanzas, en menos de 1 minuto tiene que volver a decir "Conectada por cable de red".
3. **Apagar y prender la balanza:** después tocar "PASAR PRODUCTOS". Tiene que conectar sola.
4. **Reiniciar la PC:** abrir Patagonia → Mis balanzas. Tiene que decir "Conectada por cable de red" sin instalar nada de nuevo.
5. **Cambio de dirección:** cambiarle la IP a la balanza en su menú, dentro de la misma red (por ejemplo terminada en 201), y tocar "PASAR PRODUCTOS". Tiene que encontrarla sola.

Si algo falla, el diagnóstico llega solo a soporte (panel → Reportes de balanzas).
