# Balanzas por cable de red (UTP / Ethernet)

Asistente "Conectar balanza por cable de red" (Mis balanzas → Agregar balanza). Código: `apps/web/src/features/scales/network/` (lógica en `net-wizard.ts`, probada en `net-wizard.test.ts`), programa de la PC `apps/web/public/patagonia-print-agent.ps1` versión 6.

## Cómo funciona

1. Chrome no puede abrir una conexión de red con un aparato. Lo hace el programa de Patagonia en la PC (127.0.0.1:9101), el mismo de la impresora.
2. **Versión 6 del programa** (17/11/2026):
   - `/scale/find?ports=1001,10001` busca en la red de cada placa de la PC (las 254 direcciones de su red) y devuelve `scales: [{ip, port}]`. 1001 = Kretz Report, 10001 = Systel Cuora Max (módulo Lantronix). Así reconoce la marca.
   - También devuelve `wired`: las placas con cable, prendidas o no (`up: false` = luz del cable apagada) y sus direcciones.
   - Sigue contestando `found` (lista de IP del primer puerto) para la web de antes.
   - Solo abre puertos de balanza: 1000-1099 y 10001.
3. La web decide qué le pasa al local (`analyzeSearch`). Las situaciones son: encontradas, luz apagada, PC sin entrada de cable, cable directo sin router (la PC tiene una dirección 169.254.x.x), PC sin red, o no apareció. Para cada una muestra los pasos en palabras del local.
4. Al tocar CONECTAR sigue el camino de siempre de Mis balanzas: lee la balanza, pasa los productos comprobando cada uno, prueba la etiqueta. La balanza queda recordada por su dirección (`red:IP:puerto`).
5. Por red, la búsqueda de Kretz y Systel ya no prueba velocidades ni bits de stop. Esas pruebas son del cable serie, y por red solo hacían que una balanza que no contesta tardara minutos.

## Qué se comprobó

- El programa versión 6 en una PC real con Windows: busca en dos puertos a la vez, encuentra dos balanzas de prueba (TCP en 1001 y 10001), ve la placa de cable desenchufada (`up: false`), rechaza un puerto que no es de balanza, y la llamada vieja (`port=1001`) sigue andando.
- El asistente en el navegador (modo demo) recorriendo todas las pantallas, contra ese programa real.
- 28 pruebas de la lógica (respuestas reales del programa, reconocer la marca, sugerir IP, textos sin palabras técnicas).

## FALTA PROBAR CON LA BALANZA

Nada de esto se probó con una balanza real por red:

1. **Kretz Report NX2 (El Shopping de la Carne, 192.168.19.170):**
   - Que conteste por la red igual que la LT por USB: 0001, 5005 y 2005 con relectura.
   - Si el cable va directo a la PC: que con la IP que sugiere el asistente (169.254.x.200, máscara 255.255.0.0) la encuentre.
2. **La ruta del menú de la IP en la Report NX:** el manual dice "Configuración de Red: NRO BALANZA, IP, PUERTO". No sabemos si tiene opción de máscara o de DHCP.
3. **Systel Cuora Max por red:**
   - Que el módulo Lantronix pase las tramas igual que el USB (fin de trama por silencio).
   - La ruta del menú de la IP: el asistente dice "Menú 11 (Comunicaciones) → Red → IP", sin confirmar.
4. **Firewall de Windows:** que no frene al programa al salir hacia la balanza (es una conexión de salida; no debería).
5. **Chrome en la PC del cliente:** qué nombre de permiso de "red local" informa. Se consultan `loopback-network`, `local-network-access` y `local-network`.

### Pruebas para hacer en el local (El Shopping de la Carne)

1. Instalar el programa nuevo (Agregar balanza → Conectar balanza por cable de red → DESCARGAR) y abrir http://127.0.0.1:9101/ping. Tiene que decir `"version":6`.
2. Dónde va el cable: si va directo a la PC, seguir lo que dice el asistente (IP y máscara en la balanza) y BUSCAR.
3. Que aparezca "Encontramos tu balanza" con Kretz Report, ponerle nombre y CONECTAR.
4. Que lea la balanza (productos), SINCRONIZAR un producto de prueba, imprimir una etiqueta y escanearla en Mostrador.
5. Apagar y prender la balanza: "PASAR PRODUCTOS" tiene que encontrarla sola.
6. Si algo falla: "Mandar diagnóstico a soporte" y revisar el reporte en el panel (scale_support_reports).

## Marcas sin red desde el sistema

- **Kretz Aura:** no tiene conector de red. Va por USB/serie (anda: Pollo y mar).
- **Systel Cuora Neo:** no tiene protocolo directo. Importa un CSV desde un servidor FTP/SFTP (docs/SYSTEL_INFORME.md). Alternativa hoy: Stock → "Descargar lista para balanza" y cargarla con el programa de Systel. Para que Patagonia mande precios solo haría falta publicar ese CSV en un FTP/SFTP. No lo tenemos.
- **Otras marcas:** el asistente pide una foto de la etiqueta de atrás por WhatsApp y ofrece "Buscarla sola en la red".
