# Patagonia Scale Connect (`@patagonia/connector`)

Servicio de Windows (Node 22 + TypeScript) que es el **único dueño** de los puertos y
conexiones de las balanzas de una PC. Diseño: `docs/PLAN_BALANZAS_V2.md`, sección 5
(rama `proyecto/balanzas-v2`).

Este lote es la **base**: enlaces de bytes, descubridor, gestor de puertos, trabajadores,
diario, canal local, configuración, bitácora y empaquetado. **Sin protocolos ni nube.**

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
| `cloud/` | Canal con la nube (migración 226). `CloudClient` (HTTPS a `scale-connect-pair` / `scale-connect-api`, encabezado `x-scale-connector: <id>.<secreto>`), `CloudAgent` (latido cada 60 s, consulta larga a `/claim`, espera creciente sin conexión, avance y cierre; si la nube dice 401/403 corta todo y borra la credencial), `JobExecutor` (costura con los protocolos: hoy `UnavailableExecutor` cierra como `sin_protocolo`), credencial en `credential.json` cifrada con DPAPI de **máquina** (ProtectedData vía PowerShell, el secreto por stdin), huella = SHA-256 de nombre del equipo + MachineGuid, y la página `GET/POST /vincular`. |
| `config/`, `log/` | `%ProgramData%\Patagonia\ScaleConnect\` (`config.json`, `logs\connector.log` rotada, `journal\jobs.json`). En desarrollo `.data/`; se fuerza con `PATAGONIA_CONNECT_HOME`. La bitácora borra secretos (por nombre de campo y por patrón). |

## Empaquetar (sin firmar todavía)

```bash
npm run build -w @patagonia/connector        # esbuild -> dist/scale-connect.cjs (un solo JS, serialport afuera)
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

- **Protocolos** Kretz y Systel: pasan a `packages/scale-protocols` y hablan con `ByteLink`.
  Hoy no hay nada de protocolo acá.
- Ejecutor real de trabajos de la nube (`JobExecutor` sobre los protocolos) y diario local por trabajo de la nube.
- "Reemplaza a Caja 1" en una PC nueva (hoy solo se recupera con la misma huella).
- Descubrimiento de **balanzas de red** (subredes, 169.254.x, puertos 1001/10001, ARP).
- Peso en vivo para Mostrador (WebSocket local).
- **Actualizador** firmado con Ed25519 y vuelta atrás automática.
- **Instalador** Inno Setup **firmado** y certificado de firma de código.
- Diario sobre SQLite (`better-sqlite3`), si el JSON queda chico.
