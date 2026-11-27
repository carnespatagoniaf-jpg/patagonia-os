# Tarea programada del actualizador de Patagonia Scale Connect. La corre el instalador (packaging/installer.iss) como
# administrador; nunca el servicio. Solo ASCII a proposito (PowerShell 5.1 lee los .ps1 sin BOM como ANSI).
#
#   updater-task.ps1 -Exe "C:\Program Files\Patagonia\Scale Connect\scale-connect.exe"   registra (o reemplaza)
#   updater-task.ps1 -Remove                                                             la saca
#
# La tarea corre como SYSTEM (SID S-1-5-18) "scale-connect.exe --update": al arrancar Windows (3 minutos despues) y
# cada 15 minutos. El programa decide si toca revisar (cada 6 h, al arrancar, o si el servicio dejo un pedido) y sale
# enseguida si no. El ejecutable esta en Program Files: el servicio no puede escribir ahi (solo lectura y ejecucion).
param(
  [string]$Exe,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Actualizador de Patagonia Scale Connect'
$TaskPath = '\Patagonia\'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}
if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { throw "No existe el ejecutable: $Exe" }

$action = New-ScheduledTaskAction -Execute $Exe -Argument '--update' -WorkingDirectory (Split-Path -Parent $Exe)
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT3M'
$every = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $action -Trigger @($boot, $every) -Principal $principal -Settings $settings -Description 'Actualiza Patagonia Scale Connect con versiones firmadas por Patagonia System.' -Force | Out-Null
Write-Output "Tarea registrada: $TaskPath$TaskName"
