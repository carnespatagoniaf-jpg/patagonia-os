# Diagnostico de Patagonia Scale Connect y de las balanzas de esta PC.
# Junta TODO lo que soporte necesita en un .zip en el Escritorio. No cambia nada en la PC ni en las balanzas.
# No incluye la credencial del servicio (credential.json) ni ninguna clave.
# Uso: doble clic en "Diagnostico balanzas.bat" (pide permiso de administrador para leer la carpeta del servicio).
# Archivo solo ASCII a proposito (PowerShell 5.1).

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$desk = [Environment]::GetFolderPath('Desktop')
if (-not $desk) { $desk = $env:PUBLIC + '\Desktop' }
$work = Join-Path $env:TEMP ("diag-balanzas-" + $stamp)
New-Item -ItemType Directory -Force -Path $work | Out-Null
$data = Join-Path $env:ProgramData 'Patagonia\ScaleConnect'
$resumen = New-Object System.Collections.Generic.List[string]

function Paso($titulo, [scriptblock]$bloque, $archivo) {
  Write-Host ("- " + $titulo + "...")
  try {
    $out = & $bloque 2>&1 | Out-String -Width 400
  } catch {
    $out = "ERROR: " + $_.Exception.Message
  }
  Set-Content -Path (Join-Path $work $archivo) -Value $out -Encoding UTF8
  return $out
}

function Ok($texto) { $resumen.Add("[OK]    " + $texto); Write-Host ("  OK: " + $texto) -ForegroundColor Green }
function Mal($texto) { $resumen.Add("[REVISAR] " + $texto); Write-Host ("  REVISAR: " + $texto) -ForegroundColor Yellow }

Write-Host ''
Write-Host 'Diagnostico de balanzas - Patagonia Scale Connect' -ForegroundColor Cyan
Write-Host ''

# 1. PC
Paso 'Datos de la PC' { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, LastBootUpTime; "Equipo: $env:COMPUTERNAME"; "Hora: $(Get-Date -Format o)" } '01-pc.txt' | Out-Null

# 2. Servicio
$svc = Get-Service -Name 'PatagoniaScaleConnect' -ErrorAction SilentlyContinue
Paso 'Servicio de Windows' {
  if ($svc) { $svc | Format-List Name, DisplayName, Status, StartType; & "$env:SystemRoot\System32\sc.exe" qc PatagoniaScaleConnect; & "$env:SystemRoot\System32\sc.exe" qfailure PatagoniaScaleConnect }
  else { 'El servicio PatagoniaScaleConnect NO esta instalado.' }
} '02-servicio.txt' | Out-Null
if (-not $svc) { Mal 'Scale Connect no esta instalado en esta PC.' }
elseif ($svc.Status -ne 'Running') { Mal ("El servicio esta " + $svc.Status + " (tendria que estar Running).") }
else { Ok 'El servicio esta corriendo.' }
if ($svc -and $svc.StartType -ne 'Automatic') { Mal ("El inicio del servicio es " + $svc.StartType + " (tendria que ser Automatico).") }

# 3. Estado del servicio (/status)
$status = $null
try {
  $status = Invoke-RestMethod -Uri 'http://127.0.0.1:9120/status' -TimeoutSec 5
  $status | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $work '03-status.json') -Encoding UTF8
  Ok ("El servicio responde (version " + $status.version + ").")
} catch {
  Set-Content -Path (Join-Path $work '03-status.json') -Value ("No responde: " + $_.Exception.Message) -Encoding UTF8
  Mal 'El servicio no responde en 127.0.0.1:9120.'
}
if ($status) {
  $txt = $status | ConvertTo-Json -Depth 12
  if ($txt -match '"paired"\s*:\s*true' -or $txt -match '"vinculad') { Ok 'La PC esta vinculada.' }
  elseif ($txt -match 'paired') { Mal 'La PC NO esta vinculada (abrir http://127.0.0.1:9120/vincular).' }
  if ($status.problems -and $status.problems.Count -gt 0) { Mal ('El servicio informa problemas: ' + (($status.problems | ForEach-Object { $_ }) -join ' | ')) }
}

# 4. Configuracion y registros (sin la credencial)
if (Test-Path $data) {
  $cfg = Join-Path $data 'config.json'
  if (Test-Path $cfg) { Copy-Item $cfg (Join-Path $work '04-config.json') }
  $logs = Join-Path $data 'logs'
  if (Test-Path $logs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $work 'logs') | Out-Null
    Get-ChildItem $logs -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { Copy-Item $_.FullName (Join-Path $work ('logs\' + $_.Name)) }
  }
  $journal = Join-Path $data 'journal'
  if (Test-Path $journal) {
    New-Item -ItemType Directory -Force -Path (Join-Path $work 'journal') | Out-Null
    Get-ChildItem $journal -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $work ('journal\' + $_.Name)) }
  }
  Get-ChildItem (Join-Path $env:ProgramFiles 'Patagonia\Scale Connect') -Recurse -Include *.log, *.err.log, *.out.log -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $work ('winsw-' + $_.Name)) }
} else {
  Mal ('No existe la carpeta de datos ' + $data + ' (o no hay permiso: correr como administrador).')
}

# 5. Puertos serie y adaptadores USB
Paso 'Puertos COM y adaptadores USB' {
  'PUERTOS:'; Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Name, PNPDeviceID, Status
  ''; 'DISPOSITIVOS DE PUERTOS (incluye USB-serie y Bluetooth):'
  Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Select-Object Status, FriendlyName, InstanceId
  ''; 'ADAPTADORES USB-SERIE CONOCIDOS (FTDI 0403, CH340 1A86, Prolific 067B, CP210x 10C4):'
  Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_0403|VID_1A86|VID_067B|VID_10C4' } | Select-Object Status, Class, FriendlyName, InstanceId
} '05-puertos.txt' | Out-Null
$sin = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_0403|VID_1A86|VID_067B|VID_10C4' -and $_.Status -ne 'OK' }
if ($sin) { Mal ('Hay un adaptador USB-serie con problema de driver: ' + (($sin | ForEach-Object { $_.FriendlyName }) -join ', ')) }
$com = Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue
if ($com) { Ok ('Puertos conectados: ' + (($com | ForEach-Object { $_.FriendlyName }) -join ', ')) } else { Mal 'No hay ningun puerto serie/USB conectado ahora.' }

# 6. Programas que pueden tener tomada la balanza
Paso 'Programas de balanzas abiertos' { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'itegra|qendra|jdatagate|javaw' } | Select-Object ProcessName, Id, Path } '06-programas.txt' | Out-Null
$otros = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'itegra|qendra|jdatagate' }
if ($otros) { Mal ('Esta abierto ' + (($otros | ForEach-Object { $_.ProcessName }) -join ', ') + ': puede tener tomada la balanza. Cerralo antes de enviar.') }

# 7. Red: placas, direcciones y balanzas por red conocidas
Paso 'Red de la PC' { & "$env:SystemRoot\System32\ipconfig.exe" /all } '07-ipconfig.txt' | Out-Null
$ips = @()
if ($status) { $ips = ([regex]::Matches(($status | ConvertTo-Json -Depth 12), '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})') | ForEach-Object { $_.Value }) | Select-Object -Unique }
Paso 'Balanzas por red (prueba de conexion)' {
  if (-not $ips) { 'El servicio no informa balanzas por red.' }
  foreach ($ep in $ips) {
    $h, $p = $ep.Split(':')
    $r = Test-NetConnection -ComputerName $h -Port ([int]$p) -WarningAction SilentlyContinue
    "$ep -> " + $(if ($r.TcpTestSucceeded) { 'CONTESTA' } else { 'NO CONTESTA' })
  }
} '08-red-balanzas.txt' | ForEach-Object { if ($_ -match 'NO CONTESTA') { Mal 'Una balanza por red no contesta (ver 08-red-balanzas.txt; revisar el cable).' } }

# 8. Eventos de Windows del servicio (ultimos 2 dias)
Paso 'Eventos de Windows' {
  Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddDays(-2) } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'Scale Connect|PatagoniaScaleConnect' } | Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
} '09-eventos.txt' | Out-Null

# Resumen + zip
$resumen.Insert(0, "Diagnostico Patagonia Scale Connect - $env:COMPUTERNAME - $(Get-Date -Format 'dd/MM/yyyy HH:mm')")
$resumen.Insert(1, '')
Set-Content -Path (Join-Path $work '00-RESUMEN.txt') -Value $resumen -Encoding UTF8
$zip = Join-Path $desk ("diagnostico-balanzas-" + $stamp + ".zip")
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'RESUMEN' -ForegroundColor Cyan
$resumen | Select-Object -Skip 2 | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host ('Listo. Quedo en el Escritorio: ' + $zip) -ForegroundColor Cyan
Write-Host 'Mandaselo a soporte de Patagonia (o avisa que esta en el Escritorio).'
