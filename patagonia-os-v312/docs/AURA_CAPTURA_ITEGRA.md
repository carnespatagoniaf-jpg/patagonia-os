# Captura de lo que manda iTegra a una Kretz Aura (sin la balanza de la clienta)

**Objetivo:** ver byte por byte cómo arma iTegra (el programa oficial de Kretz) un producto **por kilo** y uno **por unidad con código**, para que Patagonia los mande igual.

## Lo que ya se sabe del driver oficial (JDataGate 2.30, descargado de kretz.com.ar/software, 2026-10-03)

Se revisaron solo los archivos de configuración y de texto. No se ejecutó nada y no se abrió el código.

- `JDataGate.xml` documenta los tipos de equipo: A: Indicador Advanced · B: Plura · C: Report NX · F: Report estándar · G: Caja Registradora · **H: Nueva PPI** (la familia de la Aura; la Aura de la clienta contesta como "H").
- `COM.JDG`: cada equipo se conecta por **COM** (puerto serie), **VCOM** o **TCP** (IP + puerto, por ejemplo `"01","C","3","TCP","192.168.99.205","1001"`).
- `INFO.JDG`: una línea por comando ya armado. Ejemplos de Kretz: `H010001` (test a una "H") y `C012005…` (PLU de la Report).
- `CONF.JDG` solo tiene el idioma (`00`). **El modelo de datos de los productos NO está en el driver.**
- El driver tiene 3 partes propias: `JDataGate`, `Comunicacion` y `Comandos`. Toma las líneas de INFO.JDG, les agrega el inicio, el fin y el checksum, y las manda.
- **Conclusión:** quien arma el registro de 42 caracteres de la Aura (tipo y código incluidos) es **iTegra**. Hay que ver qué escribe iTegra.

## La herramienta: Aura de mentira (`scripts/aura-captura.ts`)

- Servidor TCP que **solo escucha en 127.0.0.1**, es decir en esta misma PC.
- Contesta 0001, 1500 y 5005 con los **mismos bytes** que la Aura real, y arranca con sus 6 productos.
- Guarda el 2005 tal cual llega.
- Contesta "inexistente" a cualquier otro comando, pero lo registra.
- Cada byte que entra y sale queda en un archivo JSON, en hexadecimal y en texto.
- Verificado: pruebas automáticas (`aura-fake-device.test.ts`) y una prueba real por TCP con 0001, 1500, 2005 y 5005.

```
npx tsx scripts/aura-captura.ts 1001 captura-aura.json
```

## Procedimiento (en la PC del dueño; la clienta no participa)

1. **Descargar iTegra** desde la carpeta oficial enlazada en kretz.com.ar/software: `iTegra_setup_4-148.exe`, 477 MB.
2. **Revisión estática antes de instalar** (sin ejecutar). Es un instalador del mismo tipo que JDataGate, que se puede abrir como un zip. Se listan sus componentes: si instala drivers USB, servicios o base de datos, y si trae ejemplos o modelos de equipos. Se informa al dueño.
3. **Con autorización del dueño:** instalar iTegra.
4. Levantar la Aura de mentira: `npx tsx scripts/aura-captura.ts 1001 captura-aura.json`.
5. En iTegra:
   - Dar de alta un equipo **Aura / PPI**, número 01, conectado por **TCP** a IP `127.0.0.1`, puerto `1001`.
   - Si iTegra no permite TCP para la Aura: elegir un puerto COM que no exista. Lo que interesa es el `INFO.JDG` que arma iTegra (ver "Plan B").
6. Crear 3 productos de prueba:
   - **PLU 50 "PRUEBA KILO"**: pesable, código 50, precio 1234.
   - **PLU 51 "PRUEBA UNIDAD"**: no pesable, código 51, precio 500.
   - **PLU 52 "PRUEBA CODIGO"**: pesable, código 777, precio 999 (para ver un código distinto del PLU).
7. Enviar esos productos al equipo. La Aura de mentira muestra y guarda cada trama.
8. **Cambiar solo el precio del PLU 50** y volver a enviar. Así se ve si iTegra manda el registro entero u otra cosa.
9. Pasarnos el archivo `captura-aura.json`, que también queda en la carpeta.

**Plan B (si iTegra no deja usar TCP para la Aura):** iTegra escribe los comandos en `INFO.JDG` antes de que JDataGate los envíe. Ese archivo, junto con `LOG.JDG`, en la carpeta de iTegra, muestra el registro exacto aunque la transmisión falle por no haber balanza.

## Qué responde esta captura

- En qué posición y con qué valor manda iTegra el **tipo** (pesable o unitario) y el **código**.
- Si antes del 2005 manda algún **comando previo**, por ejemplo de configuración.
- Si para cambiar un precio reescribe el registro entero.

Con eso se programa en Patagonia el mismo formato y se prueba primero en el simulador. Después hace falta **una** escritura de confirmación en la balanza real, en un PLU libre y con autorización.

## Riesgos

- **Balanza de la clienta:** ninguno, no se usa.
- **PC del dueño:** iTegra es un programa Java con su propio Java incluido, y puede traer una base de datos local. El paso 2 lista lo que instala antes de decidir. No hay que aceptar instalar drivers USB si los ofrece (no hacen falta para TCP).
- **Red:** la Aura de mentira escucha solo en 127.0.0.1. Nada sale de la PC.
- **Datos:** iTegra crea su propia base de datos de productos de prueba. No toca Patagonia.

## Análisis estático de iTegra 4-148 (2026-10-03, sin ejecutar ni instalar)

**Descarga.** `iTegra_setup_4-148.exe` desde la carpeta "iTegra para Windows" enlazada en kretz.com.ar/software.

- Tamaño: 500.450.686 bytes.
- SHA-256: `26DFC99B400F4290AF11D31972691F9366910EA1FF74D4F5A2E930CF627DC881`.
- **Sin firma digital**, igual que JDataGate 2.30.

**Qué trae** (es un instalador InstallAnywhere/Flexera; se abre como zip):

- `iTegra.jar` (92 MB, Java 5) y bibliotecas (`Packages/`), y un **Java propio, viejo, de 32 bits**.
- **Base de datos local HSQLDB.** `info.cx` → `jdbc:hsqldb:hsql://127.0.0.1:9001/dbTest`, `arrancarBase:si`: al abrirse, levanta un servidor de base de datos que escucha solo en esta PC, en el puerto 9001.
- **Instaladores de drivers USB incluidos:**
  - FTDI `CDM20814_Setup.exe`;
  - NXP `LPCXpresso_Link2_USB_driver_package.exe`;
  - `nxpUSBlibVirtualSerial.inf` / `lpc-vcom.inf`;
  - `devcon` (herramienta de Microsoft para instalar dispositivos).
  No se puede saber sin ejecutarlo si el instalador los corre solo.
- `ServicioWin_zg_ia_sf.jar`: componente de **servicio de Windows**.
- Bandeja del sistema (`tray.dll`, `jdic.dll`).
- Su propio JDataGate (`DataGate.jar`, 2026-07-22) y un `INFO/6020_Protocolo.pdf`.

**Dónde está la estructura del producto de la Aura:**

- `CONF.JDG` y `Datos/info.xml` (modelos de datos) **solo traen el modelo "4000LCD" (Report NX LCD)**, no la Aura.
- La base inicial (`Datos.script`, tabla MODELOS) también trae solo `4000LCD`.
- La lógica de la Aura está **compilada** (paquete `AuraBackup`: `PLU`, `Configuracion`, `TDR`). No se abrió: abrirla sería descompilar.
- **Conclusión:** la estructura solo se ve **capturando** lo que iTegra manda.

**Opción recomendada: iTegra PORTÁTIL** (`scripts/preparar-itegra-portable.sh`). Copia los archivos y el Java incluido a una carpeta y deja afuera los instaladores de drivers.

- No pasa por el instalador: no hay drivers, servicio ni registro de Windows.
- Se abre con `iTegra.bat` (`..\..\jreK\bin\java -jar iTegra.jar`) solo con autorización.
- Al abrirse levanta su base de datos en 127.0.0.1:9001. Para borrarlo, se borra la carpeta.

**Espacio en disco:** el 2026-10-03 el disco C: de la PC del dueño se llenó (0 bytes libres) durante el análisis. Se borraron todas las descargas, y quedaron 2 GB libres. La preparación portátil necesita unos 1,6 GB durante el proceso y deja unos 650 MB. **Conviene liberar espacio antes.**
