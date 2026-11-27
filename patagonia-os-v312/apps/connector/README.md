# Patagonia Scale Connect (`@patagonia/connector`)

Servicio de Windows (Node 22 + TypeScript) que es el **único dueño** de los puertos y
conexiones de las balanzas de una PC. Diseño: `docs/PLAN_BALANZAS_V2.md`, sección 5
(rama `proyecto/balanzas-v2`).

Base: enlaces de bytes, descubridor, gestor de puertos, trabajadores, diario, canal local,
configuración, bitácora y empaquetado. **Protocolos Kretz y Systel: los de la web, sin
reescribirlos** (`src/protocols/`). Todavía sin nube.

## Correr

```bash
npm run dev -w @patagonia/connector     # datos en apps/connector/.data/, estado en http://127.0.0.1:9120/status
npm run ports -w @patagonia/connector   # lista los COM/USB/Bluetooth reales de esta PC (--raw: lo que dice Windows)
```

Para probar balanzas en el banco, cargalas en `.data/config.json` (`devices`):

```json
{ "devices": [
  { "id": "aura", "name": "Aura mostrador", "transport": { "type": "serial", "path": "COM3", "baudRate": 9600, "stopBits": 2 } },
  { "id": "report", "name": "Report", "transport": { "type": "tcp", "host": "169.254.137.200", "port": 1001 } }
] }
```

Lo inválido se informa en `/status` (`problems`) y en la bitácora; el servicio arranca igual.

Para la nube, `config.json` lleva `"cloud": { "url": "https://<proyecto>.supabase.co/functions/v1" }` (o la variable
`PATAGONIA_CLOUD_URL`, que va a poner el instalador). Sin eso, Scale Connect trabaja solo en la PC y `/vincular` lo
avisa. Vincular: abrir `http://127.0.0.1:9120/vincular` y escribir el código de Patagonia → Mis balanzas →
"Agregar esta computadora". El POST de esa página solo se acepta desde la misma página (Origin exacto + token).

## Probar

```bash
npm run test -w @patagonia/connector       # node --test vía tsx, sin hardware
npm run typecheck -w @patagonia/connector
```

No está en los `test`/`build`/`typecheck` de la raíz a propósito: esos siguen igual.

## Piezas (`src/`)

| Carpeta | Qué hace |
|---|---|
| `link/` | `ByteLink` (abrir, escribir, leer con tiempo de espera, cerrar, aviso de desconexión). `SerialByteLink` (serialport), `TcpByteLink` (node:net), `FakeByteLink` (pruebas). Errores clasificados: `busy_other_program` (Windows niega el acceso: lo tiene iTegra/Qendra), `not_found`, `in_use_here`, `refused`, `unreachable`, `timeout`, `closed`. |
| `discovery/` | Clasifica cada puerto (FTDI, CH340, PL2303, CP210x, Bluetooth, placa madre, virtual) y le da una huella: número de serie real si tiene; si no, la ubicación USB. Los "números de serie" con `&` los inventa Windows y no sirven. |
| `ports/` | `PortManager`: un puerto o socket = un dueño. |
| `worker/` | `DeviceWorker`: cola propia (uno a la vez), tiempo por comando, vigía (si no avanza, aborta, libera el puerto y marca fallido), reconexión 1-2-5-10-30 s. `enqueue` nunca rechaza. |
| `journal/` | Diario de trabajos con escritura atómica (temporal + `fsync` + renombrar). Al reiniciar, lo que estaba en curso queda `interrupted`/`resumable`; nunca se reenvía solo. `JournalStorage` es la costura para pasar a SQLite. |
| `server/` | `127.0.0.1:9120`, solo `GET /status` (y preflight). Revisa Host (DNS rebinding) y Origin (`https://*.patagoniasystem.com.ar`, `http://localhost`), igual que `apps/web/public/patagonia-print-agent.ps1`. Sin endpoints de escritura. |
| `protocols/` | Corre el motor de "Mi balanza" de la web **tal cual** (ver abajo). Trabajos `identify`, `test` y `send` por balanza. |
| `cloud/` | Canal con la nube (migración 226). `CloudClient` (HTTPS a `scale-connect-pair` / `scale-connect-api`, encabezado `x-scale-connector: <id>.<secreto>`), `CloudAgent` (latido cada 60 s, consulta larga a `/claim`, espera creciente sin conexión, avance y cierre; si la nube dice 401/403 corta todo y borra la credencial), `JobExecutor` (costura con los protocolos: hoy `UnavailableExecutor` cierra como `sin_protocolo`), credencial en `credential.json` cifrada con DPAPI de **máquina** (ProtectedData vía PowerShell, el secreto por stdin), huella = SHA-256 de nombre del equipo + MachineGuid, y la página `GET/POST /vincular`. |
| `config/`, `log/` | `%ProgramData%\Patagonia\ScaleConnect\` (`config.json`, `logs\connector.log` rotada, `journal\jobs.json`). En desarrollo `.data/`; se fuerza con `PATAGONIA_CONNECT_HOME`. La bitácora borra secretos (por nombre de campo y por patrón). |

## Protocolos (`src/protocols/`)

El conector **importa** el código de `apps/web/src/features/...` (adaptadores Kretz y Systel,
`scale-serial.ts`, `kretz/*`, `systel/*`); no hay copia. `web-entry.ts` lista las piezas.

| Pieza | Qué hace |
|---|---|
| `web-runtime.ts` | Empaqueta `web-entry.ts` (esbuild, IIFE) y lo evalúa **una vez por balanza** con `new Function`, pasándole su `localStorage`, su `navigator.serial` y `window`/`BroadcastChannel` = `undefined`. Cada balanza tiene sus variables de módulo (puerto elegido, formato de etiqueta) como una pestaña aparte, y nada se instala en el `globalThis` del servicio. En el `.cjs` el texto va adentro (`__WEB_PROTOCOLS_SOURCE__`); en desarrollo se empaqueta al vuelo. |
| `web-serial-shim.ts` | `WebSerialPortShim`: forma de `SerialPort` de Web Serial (`open`, `readable`/`writable` como streams web, `setSignals`, `getInfo`, `close`, evento `disconnect`) sobre el `ByteLink` que presta el trabajo. Otra velocidad o bits de stop = reabrir el **mismo** puerto (`SerialLineControl.reconfigure`). Fuera de un trabajo no abre. Un corte lo deja "perdido" hasta el próximo trabajo. Cada byte recibido cuenta como avance para el vigía. |
| `scale-state-store.ts` | `localStorage` de cada balanza en `protocols\<id>.json` (escritura atómica). |
| `engine-backend.ts` | `EngineBackend`: lo que el motor le pide a Patagonia (formato de etiqueta, balanzas de la sucursal, catálogo/vínculos Systel, reporte a soporte). Hoy `MemoryEngineBackend`; la nube la implementa otro lote. |
| `scale-jobs.ts` | `ScaleProtocolHost` (uno por balanza, en `service.scales`): `identify` (solo lectura), `test` y `send` (identify → `prepare` relee → `sync`). Resultado por producto: `confirmado` / `fallado` + motivo / `salteado` + motivo. Confirmar = la misma comparación de la web (`reportDifferences`, `planAuraSync`, lo que Systel guarda para Mostrador); cada confirmado va al diario (`producto:<código>`). Un envío interrumpido nunca se reenvía solo: el próximo relee la balanza y escribe solo lo que falta. |
| `testing/` | Simuladores: Report a nivel de bytes (servidor TCP local), `FakeAuraDevice` y `FakeCuora` de la web detrás de un `FakeByteLink`. |

La Report por TCP se arma como una `NetScalePort` de la web (`makeConnectorNetPort`): el
código Kretz la trata "por red" igual que en el navegador (sin velocidades, etiqueta 2-5-5).

Typecheck: `tsconfig.json` revisa todo con `DOM` y los `.d.ts` de la web (la web no usa
`noUnusedLocals`); `tsconfig.core.json` revisa el núcleo sin `DOM` y con `noUnused*`.

## Empaquetar (sin firmar todavía)

```bash
npm run build -w @patagonia/connector        # esbuild -> dist/scale-connect.cjs (un solo JS, serialport afuera; ~333 KB, ~232 KB son los protocolos de la web)
npm run package:sea -w @patagonia/connector  # Node SEA -> dist/package/
```

`dist/package/` queda así:

```
PatagoniaScaleConnect.exe   WinSW-x64.exe renombrado (lo agrega el instalador)
PatagoniaScaleConnect.xml   packaging/PatagoniaScaleConnect.xml
scale-connect.exe           node.exe + bundle inyectado (Node SEA)
node_modules/serialport/…   JS de serialport + @serialport/bindings-cpp/prebuilds/win32-x64/*.node
```

Plan SEA + módulo nativo:
- El bundle es CommonJS porque SEA en Node 22 solo ejecuta CJS.
- Dentro de SEA, `require` solo ve los módulos internos de Node. Por eso
  `native/serialport-loader.ts` usa `createRequire` desde la carpeta del `.exe`, y el
  script copia `serialport` y sus dependencias ahí, con solo el `.node` de win32-x64.
- `serialport` usa N-API precompilado: no hace falta compilar, y el `.node` sirve
  para cualquier Node 22 o posterior.
- Para inyectar el bundle hace falta `postject`. El script avisa si falta. Armar
  con **Node 22 LTS x64**.
- `node.exe` viene firmado: hay que sacarle la firma antes de inyectar
  (`signtool remove /s`) y firmar `scale-connect.exe` con el certificado propio después.

Servicio (WinSW v3): inicio automático diferido, reinicio ante caída (5 s, 15 s, 60 s) y
cuenta virtual `NT SERVICE\PatagoniaScaleConnect`, sin administrador. Instalar con
`PatagoniaScaleConnect.exe install`. Si la versión de WinSW no acepta la cuenta virtual,
el XML trae los comandos `sc.exe`/`icacls` alternativos.

## Qué falta

- **Protocolos en hardware real**: hasta ahora solo contra simuladores (ver `protocols/`).
  Más adelante, cuando el otro lote termine de mover archivos, pasar `web-entry.ts` a
  `packages/scale-protocols` sin cambiar el conector.
- **Vinculación** (código de 8 caracteres, credencial con DPAPI) y **canal con la nube**
  (Edge Function, trabajos, latido).
- **Protocolos** Kretz y Systel: pasan a `packages/scale-protocols` y hablan con `ByteLink`.
  Hoy no hay nada de protocolo acá.
- Ejecutor real de trabajos de la nube (`JobExecutor` sobre los protocolos) y diario local por trabajo de la nube.
- "Reemplaza a Caja 1" en una PC nueva (hoy solo se recupera con la misma huella).
- Descubrimiento de **balanzas de red** (subredes, 169.254.x, puertos 1001/10001, ARP).
- Peso en vivo para Mostrador (WebSocket local).
- **Actualizador** firmado con Ed25519 y vuelta atrás automática.
- **Instalador** Inno Setup **firmado** y certificado de firma de código.
- Diario sobre SQLite (`better-sqlite3`), si el JSON queda chico.
