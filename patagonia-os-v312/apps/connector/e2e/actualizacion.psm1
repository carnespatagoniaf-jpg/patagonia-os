# Ayudas de la prueba de ACTUALIZACION automatica en una PC limpia (.github/workflows/scale-connect-update-e2e.yml).
# Usa las de e2e.psm1 (Assert-Check, Save-Evidence, Get-Status, Wait-Until...) y agrega la nube falsa local
# (e2e/nube-falsa.ts) y la tarea programada del actualizador.
# Cada paso: Import-Module ./apps/connector/e2e/actualizacion.psm1 -Force

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'e2e.psm1') -Force -Global

$script:CtrlUrl = 'http://127.0.0.1:9401'
$script:CloudUrl = 'http://127.0.0.1:9400/functions/v1'
$script:TaskPath = '\Patagonia\'
$script:TaskName = 'Actualizador de Patagonia Scale Connect'
$script:UpdaterDir = Join-Path $env:ProgramData 'Patagonia\ScaleConnect-Updater'

function Get-CloudUrl { $script:CloudUrl }
function Get-UpdaterDir { $script:UpdaterDir }
function Get-InstallersDir { Join-Path $env:RUNNER_TEMP 'instaladores' }
function Get-KeysDir { Join-Path $env:RUNNER_TEMP 'claves-efimeras' }

function Invoke-Nube {
  param([string]$Method = 'GET', [string]$Path, $Body = $null)
  $params = @{ Method = $Method; Uri = ($script:CtrlUrl + $Path); TimeoutSec = 15 }
  if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress); $params.ContentType = 'application/json' }
  Invoke-RestMethod @params
}

function Get-NubeEstado { Invoke-Nube -Path '/estado' }

function Get-Reports { @((Get-NubeEstado).updateReports) }

# Una fila de tiempos (va al resumen).
function Add-Timing {
  param([string]$Scenario, [double]$Seconds, [string]$Result)
  $line = "{0}`t{1}`t{2}" -f $Scenario, $Result, [math]::Round($Seconds, 1)
  Add-Content -Path (Join-Path (Get-E2EOut) 'tiempos.tsv') -Value $line -Encoding utf8
}

function Get-ExeVersion {
  $exe = Join-Path (Get-AppDir) 'scale-connect.exe'
  if (-not (Test-Path $exe)) { return $null }
  return ((& $exe --version) -join '').Trim()
}

function Get-FileSha {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-UpdaterState {
  $f = Join-Path $script:UpdaterDir 'estado.json'
  if (-not (Test-Path $f)) { return $null }
  Get-Content $f -Raw | ConvertFrom-Json
}

# Lo que quedo de la vinculacion: id del conector, que la credencial exista (su hash, nunca su contenido), config.json
# (hash y nube) y la huella que vio la nube.
function Get-LinkSnapshot {
  $s = Get-Status
  $cfgFile = Join-Path (Get-DataDir) 'config.json'
  $credFile = Join-Path (Get-DataDir) 'credential.json'
  $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
  $nube = Get-NubeEstado
  $conn = @($nube.connectors) | Where-Object { $_.id -eq $s.cloud.connectorId } | Select-Object -First 1
  [pscustomobject]@{
    connectorId = $s.cloud.connectorId
    paired = [bool]$s.cloud.paired
    credentialExists = (Test-Path $credFile)
    credentialSha256 = (Get-FileSha $credFile)
    credentialScheme = $s.cloud.credentialScheme
    configSha256 = (Get-FileSha $cfgFile)
    cloudUrl = $cfg.cloud.url
    fingerprint = $conn.fingerprint
  }
}

function Get-RequestWrittenAt {
  $f = Join-Path (Get-DataDir) 'update\pedido.json'
  if (-not (Test-Path $f)) { return $null }
  (Get-Item $f).LastWriteTimeUtc
}

# El servicio deja el pedido cuando /config trae una version mas nueva (con el latido).
function Wait-ServiceRequest {
  param([datetime]$After, [int]$Seconds = 120)
  Wait-Until { $t = Get-RequestWrittenAt; $t -and $t -gt $After } $Seconds 'que el servicio deje update\pedido.json' 2000
}

# "Pasaron 6 horas": unica forma de que el actualizador revise sin pedido del servicio (oferta de una version que el
# servicio no pide, o una ya bloqueada). Se corre la fecha de la ultima revision en estado.json (lo puede escribir
# Administradores) y se dispara la misma tarea.
function Set-LastCheckHoursAgo {
  param([int]$Hours = 7)
  $f = Join-Path $script:UpdaterDir 'estado.json'
  $raw = Get-Content $f -Raw | ConvertFrom-Json
  $raw.lastCheckAt = (Get-Date).ToUniversalTime().AddHours(-$Hours).ToString('o')
  ($raw | ConvertTo-Json -Depth 20) | Set-Content -Path $f -Encoding utf8
}

function Start-UpdaterTask {
  Start-ScheduledTask -TaskPath $script:TaskPath -TaskName $script:TaskName
}

function Test-UpdaterRunning {
  (Test-Path (Join-Path $script:UpdaterDir 'en-curso.json')) -or [bool](Get-Process -Name 'scale-connect-updater-*' -ErrorAction SilentlyContinue)
}

# Dispara la tarea programada y espera el informe que llega a la nube (/update-report). Si a los 90 s la tarea no
# arranco una corrida (por ejemplo la de cada 15 minutos estaba justo en curso: IgnoreNew), la vuelve a disparar.
function Invoke-UpdateCycle {
  param([int]$Seconds = 600)
  $before = (Get-Reports).Count
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $lastKick = -999
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    $reports = Get-Reports
    if ($reports.Count -gt $before) {
      return [pscustomobject]@{ report = $reports[$reports.Count - 1]; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
    }
    if (($sw.Elapsed.TotalSeconds - $lastKick) -ge 90 -and -not (Test-UpdaterRunning)) {
      Write-Host "Dispara la tarea programada ($([math]::Round($sw.Elapsed.TotalSeconds)) s)"
      Start-UpdaterTask
      $lastKick = $sw.Elapsed.TotalSeconds
    }
    Start-Sleep -Seconds 3
  }
  throw "No llego el informe de la actualizacion en $Seconds s"
}

# Un /claim autenticado (200) despues de `After`, con el conector en esa version.
function Test-ClaimOk {
  param([datetime]$After, [string]$Version)
  $ms = [DateTimeOffset]::new($After.ToUniversalTime()).ToUnixTimeMilliseconds()
  $calls = @(Invoke-Nube -Path "/llamadas?desde=$ms")
  @($calls | Where-Object { $_.path -like 'scale-connect-api/claim*' -and $_.status -eq 200 -and $_.connectorVersion -eq $Version }).Count -gt 0
}

function Wait-ClaimOk {
  param([datetime]$After, [string]$Version, [int]$Seconds = 120)
  Wait-Until { Test-ClaimOk $After $Version } $Seconds "un /claim autenticado de la $Version" 2000
}

function Install-Version {
  param([string]$Version, [string]$LogName, [string[]]$Extra = @())
  $setup = Join-Path (Get-InstallersDir) "PatagoniaScaleConnect-Setup-$Version.exe"
  if (-not (Test-Path $setup)) { throw "No esta $setup" }
  $log = Join-Path (Get-E2EOut) $LogName
  $argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"") + $Extra
  (Start-Process -FilePath $setup -ArgumentList $argList -Wait -PassThru).ExitCode
}

# Arranca un proceso que sobrevive al paso (Actions mata lo que arranca un paso cuando termina).
function Start-Detached {
  param([string]$CommandLine, [string]$Dir)
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine; CurrentDirectory = $Dir }
  if ($r.ReturnValue -ne 0) { throw "No arranco (Win32_Process.Create $($r.ReturnValue)): $CommandLine" }
  $r.ProcessId
}

# Verifica que la PC sigue igual de vinculada y sana despues de una actualizacion o una vuelta atras.
function Assert-SameLink {
  param([string]$Area, $Before, [string]$Version, [datetime]$Since)
  $s = Get-Status
  $svc = Get-Service PatagoniaScaleConnect
  Assert-Check $Area "/status responde la $Version" ($s -and $s.version -eq $Version) "$($s.version)"
  $exe = Get-ExeVersion
  Assert-Check $Area "scale-connect.exe --version = $Version" ($exe -eq $Version) $exe
  Assert-Check $Area 'El servicio esta corriendo' ($svc.Status -eq 'Running') "$($svc.Status)"
  $now = Get-LinkSnapshot
  Assert-Check $Area 'Misma vinculacion (mismo connectorId)' ($now.paired -and $now.connectorId -eq $Before.connectorId) $now.connectorId
  Assert-Check $Area 'La credencial sigue (mismo archivo, sin mostrarla)' ($now.credentialExists -and $now.credentialSha256 -eq $Before.credentialSha256) "sha256 igual: $($now.credentialSha256 -eq $Before.credentialSha256)"
  Assert-Check $Area 'config.json igual' ($now.configSha256 -eq $Before.configSha256) ''
  Assert-Check $Area 'Misma nube' ($now.cloudUrl -eq $Before.cloudUrl) $now.cloudUrl
  $secs = Wait-ClaimOk $Since $Version
  Assert-Check $Area 'La credencial sigue sirviendo: /claim autenticado OK' $true "a los $secs s, conector en la $Version"
}

Export-ModuleMember -Function *
