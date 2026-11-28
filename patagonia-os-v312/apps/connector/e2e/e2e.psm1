# Ayudas de la prueba de punta a punta en una PC limpia (.github/workflows/scale-connect-e2e.yml).
# Cada paso del workflow hace: Import-Module ./apps/connector/e2e/e2e.psm1 -Force

$ErrorActionPreference = 'Stop'

$script:ServiceId = 'PatagoniaScaleConnect'
$script:AppDir = Join-Path $env:ProgramFiles 'Patagonia\Scale Connect'
$script:DataDir = Join-Path $env:ProgramData 'Patagonia\ScaleConnect'
$script:StatusUrl = 'http://127.0.0.1:9120/status'
$script:SimUrl = 'http://127.0.0.1:9301'
$script:StagingUrl = 'https://loquhcwsvsbqpinefxcc.supabase.co/functions/v1'

function Get-E2EOut {
  $dir = if ($env:E2E_OUT) { $env:E2E_OUT } else { Join-Path $env:RUNNER_TEMP 'e2e-salida' }
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  return $dir
}

function Get-AppDir { $script:AppDir }
function Get-DataDir { $script:DataDir }
function Get-StagingUrl { $script:StagingUrl }
function Get-ServiceId { $script:ServiceId }

# Una comprobación: queda en comprobaciones.tsv (y en el resumen) con OK o FALLA. Si falla, corta el paso.
function Assert-Check {
  param([string]$Area, [string]$Name, [bool]$Ok, [string]$Detail = '')
  $line = "{0}`t{1}`t{2}`t{3}" -f $Area, $Name, ($(if ($Ok) { 'OK' } else { 'FALLA' })), ($Detail -replace "[`t`r`n]+", ' ')
  Add-Content -Path (Join-Path (Get-E2EOut) 'comprobaciones.tsv') -Value $line -Encoding utf8
  if ($Ok) { Write-Host "OK    [$Area] $Name  $Detail" } else { Write-Host "FALLA [$Area] $Name  $Detail" -ForegroundColor Red }
  if (-not $Ok) { throw "Falló: [$Area] $Name. $Detail" }
}

# Algo que NO se pudo probar en esta máquina (queda en la tabla, no corta).
function Add-Note {
  param([string]$Area, [string]$Name, [string]$Detail)
  $line = "{0}`t{1}`t{2}`t{3}" -f $Area, $Name, 'NO SE PUEDE', ($Detail -replace "[`t`r`n]+", ' ')
  Add-Content -Path (Join-Path (Get-E2EOut) 'comprobaciones.tsv') -Value $line -Encoding utf8
  Write-Host "NOTA  [$Area] $Name  $Detail" -ForegroundColor Yellow
}

function Save-Evidence {
  param([string]$Name, $Value)
  $path = Join-Path (Get-E2EOut) $Name
  if ($Value -is [string]) { Set-Content -Path $path -Value $Value -Encoding utf8 }
  else { $Value | ConvertTo-Json -Depth 30 | Set-Content -Path $path -Encoding utf8 }
}

function Get-Status {
  try { return Invoke-RestMethod -Uri $script:StatusUrl -TimeoutSec 5 } catch { return $null }
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$Seconds, [string]$What, [int]$EveryMs = 1000)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    $r = $null
    try { $r = & $Condition } catch { $r = $null }
    if ($r) { return [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    Start-Sleep -Milliseconds $EveryMs
  }
  throw "No pasó a tiempo ($Seconds s): $What"
}

function Get-ConnectorProcess {
  Get-Process -Name 'scale-connect' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-JobsCount {
  $s = Get-Status
  if (-not $s -or -not $s.cloud) { return -1 }
  return [int]$s.cloud.jobsDone + [int]$s.cloud.jobsFailed
}

function Invoke-Sim {
  param([string]$Method = 'GET', [string]$Path)
  Invoke-RestMethod -Method $Method -Uri ($script:SimUrl + $Path) -TimeoutSec 10
}

function Save-SimState {
  param([string]$Name)
  $st = Invoke-Sim -Path '/estado'
  Save-Evidence $Name $st
  return $st
}

function Get-ServiceInfo {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($script:ServiceId)'"
  if (-not $svc) { return $null }
  $reg = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($script:ServiceId)"
  [pscustomobject]@{
    State = $svc.State
    StartMode = $svc.StartMode
    DelayedAutostart = [int]($reg.DelayedAutostart)
    StartName = $svc.StartName
    ProcessId = $svc.ProcessId
    PathName = $svc.PathName
  }
}

# Instala con Inno Setup en silencio. Devuelve el código de salida.
function Install-ScaleConnect {
  param([string]$LogName, [string[]]$Extra = @())
  $setup = Get-ChildItem 'apps/connector/dist/installer/PatagoniaScaleConnect-Setup-*.exe' | Select-Object -First 1
  if (-not $setup) { throw 'No está el instalador' }
  $log = Join-Path (Get-E2EOut) $LogName
  $argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"") + $Extra
  $p = Start-Process -FilePath $setup.FullName -ArgumentList $argList -Wait -PassThru
  return $p.ExitCode
}

function Uninstall-ScaleConnect {
  param([string]$LogName, [string[]]$Extra = @())
  $unins = Join-Path $script:AppDir 'unins000.exe'
  $log = Join-Path (Get-E2EOut) $LogName
  $argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"") + $Extra
  $p = Start-Process -FilePath $unins -ArgumentList $argList -Wait -PassThru
  # El desinstalador se copia a %TEMP% y sigue solo: esperar a que termine de verdad.
  Wait-Until { -not (Get-Process -Name '_iu*', 'unins000' -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $script:AppDir 'scale-connect.exe')) } 120 'que termine la desinstalación' | Out-Null
  return $p.ExitCode
}

# ¿Algún usuario común (Usuarios, Usuarios autentificados, Todos, Interactivo) puede leer esto? Devuelve los que pueden.
function Get-CommonReaders {
  param([string]$Path)
  $common = @('S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', 'S-1-5-4')
  (Get-Acl $Path).Access | Where-Object {
    $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }
    $_.AccessControlType -eq 'Allow' -and $sid -in $common -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)
  } | ForEach-Object { "$($_.IdentityReference) $($_.FileSystemRights)" }
}

# La IP de la red local de esta PC (el conector solo habla con balanzas de la red local).
function Get-LanIp {
  $ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.AddressState -eq 'Preferred' } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if (-not $ip) { throw 'Esta PC no tiene una IP de red local (10.x, 172.16-31.x, 192.168.x)' }
  return $ip
}

Export-ModuleMember -Function *
