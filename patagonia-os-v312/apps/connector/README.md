# Patagonia Scale Connect (`@patagonia/connector`)

Servicio de Windows (Node 22 + TypeScript) que es el **único dueño** de los puertos y
conexiones de las balanzas de una PC. Diseño: `docs/PLAN_BALANZAS_V2.md`, sección 5
(rama `proyecto/balanzas-v2`).

Base: enlaces de bytes, descubridor, gestor de puertos, trabajadores, diario, canal local,
configuración, bitácora y empaquetado. **Protocolos Kretz y Systel: los de la web, sin
reescribirlos** (`src/protocols/`). Con la nube de punta a punta (migraciones 226 y 227, `src/scales/`).

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
`PATAGONIA_CLOUD_URL`, que gana). El instalador la escribe con `/NUBE=produccion` (por omisión) | `pruebas` | una
dirección https, vía `scale-connect.exe --set-cloud <valor> [--if-missing]`: solo toca `cloud.url`, y sin `/NUBE=` una
actualización mantiene la que había. `/vincular` dice a qué sistema se vincula (en pruebas, en rojo). Sin eso, Scale Connect trabaja solo en la PC y `/vincular` lo
avisa. Vincular: abrir `http://127.0.0.1:9120/vincular` y escribir el código de Patagonia → Mis balanzas →
"Agregar esta computadora". El POST de esa página solo se acepta desde la misma página (Origin exacto + token).

## Probar

```bash
npm run test -w @patagonia/connector       # node --test vía tsx, sin hardware (incluye scripts/lib/*.test.mjs)
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
| `cloud/` | Canal con la nube (migración 226). `CloudClient` (HTTPS a `scale-connect-pair` / `scale-connect-api`, encabezado `x-scale-connector: <id>.<secreto>`), `CloudAgent` (latido cada 60 s, consulta larga a `/claim`, espera creciente sin conexión, avance y cierre; si la nube dice 401/403 corta todo y borra la credencial), `JobExecutor` (costura con los protocolos; el real es `ScaleJobExecutor` de `scales/`), hasta 4 trabajos a la vez
(uno por balanza; dos a la misma esperan en su cola), configuración de la nube después de cada latido, credencial en `credential.json` cifrada con DPAPI de **máquina** (ProtectedData vía PowerShell, el secreto por stdin), huella = SHA-256 de nombre del equipo + MachineGuid, y la página `GET/POST /vincular`. |
| `config/`, `log/` | `%ProgramData%\Patagonia\ScaleConnect\` (`config.json`, `logs\connector.log` rotada, `journal\jobs.json`). En desarrollo `.data/`; se fuerza con `PATAGONIA_CONNECT_HOME`. La bitácora borra secretos (por nombre de campo y por patrón). |

## Protocolos (`src/protocols/`)

El conector **importa** el código de `apps/web/src/features/...` (adaptadores Kretz y Systel,
`scale-serial.ts`, `kretz/*`, `systel/*`); no hay copia. `web-entry.ts` lista las piezas.

| Pieza | Qué hace |
|---|---|
| `web-runtime.ts` | Empaqueta `web-entry.ts` (esbuild, IIFE) y lo evalúa **una vez por balanza** con `new Function`, pasándole su `localStorage`, su `navigator.serial` y `window`/`BroadcastChannel` = `undefined`. Cada balanza tiene sus variables de módulo (puerto elegido, formato de etiqueta) como una pestaña aparte, y nada se instala en el `globalThis` del servicio. En el `.cjs` el texto va adentro (`__WEB_PROTOCOLS_SOURCE__`); en desarrollo se empaqueta al vuelo. |
| `web-serial-shim.ts` | `WebSerialPortShim`: forma de `SerialPort` de Web Serial (`open`, `readable`/`writable` como streams web, `setSignals`, `getInfo`, `close`, evento `disconnect`) sobre el `ByteLink` que presta el trabajo. Otra velocidad o bits de stop = reabrir el **mismo** puerto (`SerialLineControl.reconfigure`). Fuera de un trabajo no abre. Un corte lo deja "perdido" hasta el próximo trabajo. Cada byte recibido cuenta como avance para el vigía. |
| `scale-state-store.ts` | `localStorage` de cada balanza en `protocols\<id>.json` (escritura atómica). |
| `engine-backend.ts` | `EngineBackend`: lo que el motor le pide a Patagonia (formato de etiqueta, balanzas de la sucursal, catálogo/vínculos Systel, reporte a soporte). `MemoryEngineBackend` fuera de los trabajos de la nube (banco); en un trabajo de la nube va `CloudEngineBackend` (`scales/`), que se pasa por envío (`SendInput.backend`). |
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
## Ejecutable e instalador (sin firmar todavía)

### Armar en esta PC

Hace falta Windows x64. Para el instalador, además, [Inno Setup 6.3+](https://jrsoftware.org/isdl.php)
(o la variable `ISCC` con la ruta de `ISCC.exe`).

```bash
npm run package -w @patagonia/connector    # build + ejecutable -> dist/PatagoniaScaleConnect/
npm run smoke -w @patagonia/connector      # prueba: --version y /status, sin instalar nada
npm run installer -w @patagonia/connector  # Inno Setup -> dist/installer/PatagoniaScaleConnect-Setup-X.Y.Z.exe (+ .sha256)
```

`dist/PatagoniaScaleConnect/` queda así (es lo que copia el instalador):

```
scale-connect.exe           Node 22 + el bundle inyectado (Node SEA), sin la firma de node.exe
PatagoniaScaleConnect.exe   WinSW v3 x64 (el servicio), bajado con SHA-256 fijo
PatagoniaScaleConnect.xml   packaging/PatagoniaScaleConnect.xml
node_modules/serialport/…   serialport y sus dependencias, solo el .node de win32-x64
build-info.json             versión, Node, WinSW y SHA-256 de cada archivo
```

Cómo se arma (`scripts/package-sea.mjs`):
- **Node 22 LTS x64, siempre.** Si el Node que corre el script es 22.x se usa ese (el CI).
  Si no (esta PC tiene Node 24), baja `node-v22.x-win-x64.zip` con el SHA-256 publicado
  por nodejs.org fijado en `scripts/lib/pinned.mjs`, a `%TEMP%\patagonia-scale-connect-build`
  (fuera del repo), y extrae solo `node.exe`. También se puede indicar uno:
  `npm run package -w @patagonia/connector -- --node C:\ruta\node.exe` o `SCALE_CONNECT_NODE`.
- El blob SEA se genera con **ese mismo** `node.exe` (el formato depende de la versión).
- `node.exe` viene firmado por OpenJS: inyectar rompe esa firma (Windows mostraría "firma
  no válida"). `scripts/lib/pe-unsign.mjs` la quita antes (lo mismo que `signtool remove /s`,
  sin necesitar el Windows SDK) y `postject` (dependencia fija `1.0.0-alpha.6`) inyecta.
- Dentro de SEA, `require` no ve `node_modules`: `src/native/serialport-loader.ts` carga
  `serialport` desde la carpeta del `.exe`. `serialport` usa N-API precompilado.
- WinSW `v3.0.0-alpha.11` se baja de GitHub y se compara con el SHA-256 fijo; si no
  coincide, el build se frena. El proyecto no publica hashes: el fijado se calculó al bajarlo
  el 27/11/2026.
- `scale-connect.exe --version` imprime la versión y sale (lo usan el CI y soporte).

### Qué hace el instalador (`packaging/installer.iss`)

- Programa en `C:\Program Files\Patagonia\Scale Connect`; datos en
  `C:\ProgramData\Patagonia\ScaleConnect` (config, diario, bitácoras), que nunca se pisan.
- Registra el servicio con WinSW: inicio **automático con retardo**, reinicio ante caídas
  (5 s, 15 s, 60 s) y parada prolija (Ctrl+C, 15 s).
- **Cuenta del servicio:** la virtual `NT SERVICE\PatagoniaScaleConnect`. WinSW v3 no puede
  instalar con ella (busca el SID antes de crear el servicio, y la cuenta virtual no existe
  hasta que el servicio existe; está explicado en el XML), así que el instalador la asigna con
  `sc.exe config … obj=` justo después de instalar y antes del primer inicio. Si Windows no la
  acepta, usa `NT AUTHORITY\LocalService` (tampoco es administrador). Las dos pueden abrir los
  puertos COM, igual que cualquier usuario. Después cierra la carpeta de datos (dueño
  Administradores, sin la herencia de ProgramData: solo SYSTEM, Administradores y el servicio la
  pueden leer, porque ahí está la credencial cifrada con DPAPI de máquina), da permiso de lectura
  en el programa e inicia el servicio.
- **Actualizar** = instalar la versión nueva encima (mismo `AppId`): frena el servicio,
  reemplaza los archivos (borra `node_modules` viejo), `refresh` de WinSW y vuelve a iniciar.
  Los datos quedan.
- Al terminar abre `http://127.0.0.1:9120/vincular` con el usuario que instaló (no como
  administrador). Si esa página todavía no existe en esta versión, igual abre la dirección.
- **Desinstalar** frena y saca el servicio y pregunta si borrar los datos (por omisión: No).
- En español. Requiere Windows 10/11 x64 y administrador.
- Silencioso, para soporte:

```bat
PatagoniaScaleConnect-Setup-0.1.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="%TEMP%\scale-connect-setup.log"
"C:\Program Files\Patagonia\Scale Connect\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES            (deja los datos)
"C:\Program Files\Patagonia\Scale Connect\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /BORRARDATOS
```

Si algo del servicio falla, el instalador lo dice (paso y código) y lo anota en el log.

### En el CI (`.github/workflows/scale-connect.yml`, raíz del repo)

Corre en `windows-latest` con Node 22 **solo** a mano (Actions → "Scale Connect
(instalador)" → Run workflow) o al subir un tag `scale-connect-vX.Y.Z` (tiene que coincidir con
`version` de este `package.json`). No corre en los PR. Pasos: `npm ci`, pruebas y tipos del
conector, `package`, `smoke`, Inno Setup (el de la imagen o `choco install innosetup`),
`installer`. Sube como artefacto el instalador sin firmar, su `.sha256` y `build-info.json`.
Los pasos de firma están comentados (ver "Qué falta").

```bash
git tag scale-connect-v0.1.0 && git push origin scale-connect-v0.1.0
```

### Probar en una PC limpia

Mejor una máquina virtual con Windows 10/11 x64 recién instalado (o Windows Sandbox), sin Node.

1. Copiar el instalador y comprobar el hash: `certutil -hashfile PatagoniaScaleConnect-Setup-0.1.0.exe SHA256`
   contra el `.sha256`.
2. Instalar con doble clic. Sin firma, SmartScreen avisa: "Más información" → "Ejecutar de todas formas".
3. Al terminar se abre el navegador en `/vincular`. `http://127.0.0.1:9120/status` tiene que responder.
4. `sc qc PatagoniaScaleConnect`: `START_TYPE AUTO_START (DELAYED)`, `SERVICE_START_NAME NT SERVICE\PatagoniaScaleConnect`.
   `sc qfailure PatagoniaScaleConnect`: tres reinicios.
5. Reiniciar Windows y esperar un par de minutos antes de iniciar sesión: en
   `C:ProgramDataPatagoniaScaleConnectlogsconnector.log` el arranque tiene que ser anterior al inicio de sesión.
6. Matar `scale-connect.exe` en el Administrador de tareas: a los 5 s vuelve.
7. Con un adaptador USB-serie enchufado, `/status` → `ports` lo lista (la cuenta del servicio ve los COM).
8. Instalar encima una versión más nueva (subir `version`, rearmar): el servicio se frena y
   vuelve, `config.json` sigue igual.
9. Desinstalar: el servicio desaparece (`sc query PatagoniaScaleConnect` → 1060) y
   `C:\ProgramData\Patagonia\ScaleConnect` queda; repetir eligiendo borrar los datos.
10. Repetir 2 y 9 en silencioso con los comandos de arriba.

### Prueba automática en una PC limpia (`.github/workflows/scale-connect-e2e.yml`)

Cada corrida de `windows-latest` es una Windows recién creada. Se dispara con un push a `prueba/scale-connect-e2e*`.
Arma e instala (`/VERYSILENT /NUBE=pruebas`), revisa el servicio (automático retrasado, cuenta virtual, permisos de
ProgramData, `/status`, nube de staging), mata el proceso, `Restart-Service`, vincula con staging por `/vincular` como
un navegador, levanta una Report y una Cuora simuladas por red (`e2e/simuladores.ts`; el runner no tiene COM), corta
una balanza a mitad, corta la red con el firewall, desinstala y reinstala, y arranca en frío. Las comprobaciones quedan
en el resumen de la corrida y los registros en el artefacto.

Lo de la nube lo hace `e2e/conducir-staging.mjs` desde la PC de quien prueba (token de staging, nunca el de producción):
crea el código de vinculación cuando el workflow llega a "Vincular con staging" (lo sube a `e2e/codigo.txt` con
`[skip ci]`), registra y vincula las balanzas, encola los trabajos de cada fase y al final compara `scale_jobs` /
`scale_job_items` con lo que quedó grabado en cada balanza simulada.

```bash
git push origin HEAD:prueba/scale-connect-e2e
node apps/connector/e2e/conducir-staging.mjs --empresa "<empresa de pruebas>" --sucursal "<sucursal>"
```

### Manifiesto de actualización (`scripts/make-update-manifest.mjs`)

`latest.json` dice versión, canal (`interno` | `piloto` | `general`), versión mínima, URL
(https), SHA-256 y tamaño del instalador, firmado con **Ed25519** (formato exacto y qué se
firma: `scripts/lib/update-manifest.mjs`). La clave privada viene **solo** de la variable
`SCALE_CONNECT_UPDATE_KEY` (PEM PKCS#8 o DER en base64); nunca va al repo.

```bash
node scripts/make-update-manifest.mjs keygen --out-dir C:\claves-scale-connect   # se niega dentro de un repo
SCALE_CONNECT_UPDATE_KEY=… npm run update-manifest -w @patagonia/connector -- \
  --url https://…/PatagoniaScaleConnect-Setup-0.2.0.exe --file dist/installer/PatagoniaScaleConnect-Setup-0.2.0.exe \
  --channel interno --min-version 0.1.0
node scripts/make-update-manifest.mjs verify --manifest dist/installer/latest.json --public-key publica.pem
```

`verifyManifest` es la misma verificación que hace el actualizador. Las pruebas
(`scripts/lib/*.test.mjs`) corren con `npm run test -w @patagonia/connector`. Para las claves de verdad no usar
`keygen` (deja la privada en un archivo): usar `scripts/preparar-claves-actualizacion.ps1` (abajo).

## Actualización automática (`src/update/`, migración 229)

El servicio corre como `NT SERVICE\PatagoniaScaleConnect` (no es administrador): **no instala**. Instala una tarea
programada como SYSTEM, "\Patagonia\Actualizador de Patagonia Scale Connect" (`packaging/updater-task.ps1`, la registra
el instalador), que corre `scale-connect.exe --update` al arrancar Windows y cada 15 minutos.

1. **Cuándo revisa:** cada 6 h, al arrancar Windows, o antes si el servicio dejó `<datos>\update\pedido.json` (lo deja
   cuando `/config` de la nube trae una versión más nueva). El lanzador se copia a
   `ScaleConnect-Updater\bin\scale-connect-updater-<versión>.exe` y corre esa copia (así el instalador puede reemplazar
   `scale-connect.exe` y su `taskkill` no lo mata).
2. **Pide la oferta** a `scale-connect-api/update` con la credencial de la PC: la base elige por canal de la empresa
   (`stable` | `pilot`) y porcentaje de despliegue (balde = SHA-256 del id del conector, módulo 100).
3. **Verifica** con la clave pública **embebida** (define de esbuild desde `SCALE_CONNECT_UPDATE_PUBKEY`): firma
   Ed25519, canal firmado, versión mínima, nunca bajar ni repetir versión; baja el instalador con tope de tamaño y
   compara tamaño y SHA-256 (también en el disco). **Sin clave embebida, apagada** (falla cerrada; `/status` → `update`
   lo dice). Un servidor de Patagonia comprometido no puede hacer instalar nada que no esté firmado.
4. **Espera** hasta 30 min a que `/status` no tenga trabajos (`cloud.currentJobs` + `jobs.running`); mientras tanto
   `avisos\pausa.json` hace que el servicio no tome trabajos nuevos (como mucho 1 h aunque el archivo quede). Si no se
   vacía, "ocupado" y reintenta después.
5. **Instala** `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` (sin `/NUBE=`: datos y nube quedan) y **comprueba** en 2 min que
   `/status` responde con la versión nueva y (si estaba en línea) con un latido posterior.
6. **Si falla**, reinstala `instaladores\anterior.exe` (verificado con el SHA-256 anotado), bloquea esa versión en esta PC
   y lo informa (`/update-report` → `scale_connectors.update_status` y `audit_log`; también `avisos\resultado.json`).

Carpetas: `C:\ProgramData\Patagonia\ScaleConnect-Updater` es **solo SYSTEM y Administradores** (sin herencia); el
servicio solo puede LEER `avisos\`. El actualizador nunca escribe ni borra en la carpeta de datos del servicio y no lee
nada de ahí a través de enlaces (junction): el servicio no puede llevar a SYSTEM a escribir en otro lado. Cada
instalación guarda su propio `.exe` como `instaladores\actual.exe` (para volver atrás). Desinstalar saca la tarea y la
carpeta. Pruebas: `src/update/*.test.ts` (instalador falso `src/update/testing/fake-installer.mjs` en un proceso aparte;
nunca uno real) y `scripts/lib/updater-acl.test.mjs` (permisos del `.iss` y de la tarea).

### Lo que tiene que hacer el dueño (una vez)

```powershell
powershell -ExecutionPolicy Bypass -File apps\connector\scripts\preparar-claves-actualizacion.ps1 -SupabaseProyecto <ref de producción> -ConStorage
```

Genera el par Ed25519 **sin mostrar la privada ni guardarla en un archivo**: va directo al secreto
`SCALE_CONNECT_UPDATE_KEY` (por stdin de `gh secret set`); la pública queda en la variable `SCALE_CONNECT_UPDATE_PUBKEY`.
Con `-SupabaseProyecto` carga la variable `SCALE_CONNECT_STORAGE_URL`; con `-ConStorage` pide sin mostrarla la clave de
servicio de Supabase (secreto `SCALE_CONNECT_STORAGE_KEY`). El bucket público `scale-connect` lo crea la migración 229.
Opcional: variable `SCALE_CONNECT_MIN_VERSION` (por omisión 0.1.0). Si el secreto ya existe se niega: cambiar la clave
deja a las PC ya instaladas sin poder actualizarse solas (hay que reinstalarlas).

### Publicar una versión

1. Tag `scale-connect-vX.Y.Z`. El CI arma el ejecutable con la clave pública y, en el job `publicar`
   (`scripts/publish-release.mjs`), firma `latest.json`, lo verifica contra la pública, sube instalador y manifiesto a
   `scale-connect/X.Y.Z/` (nunca pisa uno distinto) y crea el Release de GitHub con `publicar-X.Y.Z.sql`. Sin los
   secretos, avisa y saltea.
2. Un administrador de plataforma corre `publicar-X.Y.Z.sql` en el editor SQL (piloto al 0 %), después
   `set_scale_connect_release(id, true, 10)` → 50 → 100, y para el canal estable `publish_scale_connect_release(...,
   'stable', N)`. Frenar: `set_scale_connect_release(id, false)`. Canal de una empresa:
   `set_company_scale_connect_channel(empresa, 'pilot')`. Ver cómo va: `list_scale_connect_releases()`.

## De punta a punta con la nube (`src/scales/`, migración 227)

| Pieza | Qué hace |
|---|---|
| `scale-fleet.ts` | `ScaleFleet`: las balanzas de ESTA PC (las de `config.json` y las identificadas, guardadas en `scales.json`), cada una con su trabajador y su `ScaleProtocolHost`. Huella física: serie real del adaptador USB o su ubicación, el COM, o IP:puerto; el id local sale de la huella (si Windows cambia el COM, sigue siendo la misma). `identifyAll` prueba SOLO LEYENDO los puertos conocidos, los nuevos (USB, Bluetooth saliente, COM; nunca virtuales ni Bluetooth entrante) y las IP pedidas; los puertos sin balanza se sueltan. `applyConfig` arma scale_key → puerto con lo que vinculó la web. `seenScales` es lo que va en el latido (scale_key, o `dev:<id>` si todavía no está vinculada). |
| `scale-executor.ts` | `ScaleJobExecutor`: `send` (scale_key → puerto; si no lo sabe, pide la configuración; corre en el trabajador de esa balanza; avance = cuántos quedaron comprobados, como mucho uno por segundo; cierre = resultado de CADA producto y el mensaje para la persona en el último avance), `read` con `{"mode":"identify"}` (balanzas encontradas como productos del trabajo: `sent` = huella, `read_back` = marca, modelo, identidad) y `test`. |
| `cloud-engine-backend.ts` | `EngineBackend` contra `scale-connect-api/engine`: lee el formato y el catálogo de la sucursal del trabajo y escribe por las MISMAS RPC de la web en nombre de quien encoló (roles y auditoría iguales). |

La web (`apps/web/src/features/scales/connect/`) encola con `queue_scale_job`, consulta cada 2 s y muestra el resultado
con los mismos textos que el envío por cable. Prueba de punta a punta: `scales/end-to-end.test.ts` (nube simulada +
servicio completo + Report por TCP y Cuora por serie simulada + la lógica de la web: agregar, dos envíos en paralelo,
una que se desconecta).

## Qué falta

- **Protocolos en hardware real**: hasta ahora solo contra simuladores (ver `protocols/`).
  Más adelante, cuando el otro lote termine de mover archivos, pasar `web-entry.ts` a
  `packages/scale-protocols` sin cambiar el conector.
- **Firma de código.** Certificado (SSL.com eSigner con CodeSignTool, a confirmar); después
  descomentar los pasos de firma del CI: primero `scale-connect.exe`, después el instalador
  (y el desinstalador, con `SignTool=` en el `.iss`), y recalcular el `.sha256`. Sin firma,
  SmartScreen asusta al cliente.
- **Probar el instalador en una PC limpia** (lista de arriba). Hasta ahora: el ejecutable se
  armó y arrancó en la PC de desarrollo; el `.iss` no se compiló en ella (no tiene Inno Setup),
  lo compila el CI.
- Confirmar en el banco que la cuenta virtual abre los COM de cada adaptador (FTDI, CH340,
  PL2303, CP210x).
- Avisos de licencia de terceros (Node, WinSW, serialport) junto al programa.
- **Actualización automática:** probarla en una PC limpia (la e2e todavía no cubre la tarea programada ni un instalador
  real), pantalla en el panel de plataforma para publicar/frenar (hoy por SQL) y correr el script de claves.
- **Protocolos** Kretz y Systel: pasan a `packages/scale-protocols` y hablan con `ByteLink`.
  Hoy no hay nada de protocolo acá.
- **Protocolos** Kretz y Systel: pasan a `packages/scale-protocols` y hablan con `ByteLink`.
  Hoy no hay nada de protocolo acá.
- Probar en staging con una PC real (migración 227 + función `scale-connect-api` con la ruta `/engine` + instalador con `/NUBE=pruebas`).
- Cancelar un envío en cola desde la web (hoy, si la PC está apagada, el envío queda en cola hasta que vuelve o vence al día).
- "Reemplaza a Caja 1" en una PC nueva (hoy solo se recupera con la misma huella).
- Descubrimiento de **balanzas de red** (subredes, 169.254.x, puertos 1001/10001, ARP).
- Peso en vivo para Mostrador (WebSocket local).
- Diario sobre SQLite (`better-sqlite3`), si el JSON queda chico.
- "Instalar también el programa de impresión": queda para más adelante.
