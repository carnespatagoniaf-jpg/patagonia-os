@echo off
setlocal

rem Instala el "programa de impresion" de Patagonia OS en esta PC (una sola vez).
rem Baja patagonia-print-agent.ps1 de este mismo sitio, lo deja arrancando con
rem Windows y lo prende ahora. No necesita ser administrador ni instalar
rem ningun driver. Para sacarlo: borrar el acceso directo "Patagonia OS -
rem impresion" de la carpeta Inicio de Windows (shell:startup).
rem Ojo al editar: los parentesis dentro de un echo de un bloque if rompen el .bat.

echo Instalando el programa de impresion de Patagonia OS...
echo.

set "DIR=%LocalAppData%\PatagoniaOS"
if not exist "%DIR%" mkdir "%DIR%"
set "AGENT=%DIR%\patagonia-print-agent.ps1"

echo 1/4 Descargando el programa...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://app.patagoniasystem.com.ar/patagonia-print-agent.ps1' -OutFile $env:AGENT -UseBasicParsing } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 goto :descarga_fallo
if not exist "%AGENT%" goto :descarga_fallo

echo 2/4 Frenando la version anterior, si habia...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*patagonia-print-agent*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo 3/4 Dejandolo para que arranque solo con Windows...
powershell -NoProfile -Command "$q = [char]34; $s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\Patagonia OS - impresion.lnk'); $s.TargetPath = 'powershell.exe'; $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $q + $env:AGENT + $q; $s.WindowStyle = 7; $s.Description = 'Patagonia OS - programa de impresion de tickets'; $s.Save()"
if %ERRORLEVEL% NEQ 0 goto :atajo_fallo

echo 4/4 Prendiendolo ahora...
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%AGENT%"
ping -n 5 127.0.0.1 >nul

powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9101/ping' -TimeoutSec 3; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 goto :no_responde

echo.
echo ============================================================
echo LISTO. El programa de impresion ya esta funcionando y va a
echo arrancar solo cada vez que prendas la PC.
echo.
echo Ahora volve al sistema en Chrome:
echo   Mostrador - engranaje arriba a la derecha - "Impresora de
echo   tickets" - tocar "Ya lo instale, volver a buscar" - elegir tu
echo   impresora - "Imprimir ticket de prueba".
echo.
echo Si Chrome pregunta si permitis acceder a dispositivos de tu red
echo local, toca PERMITIR: es este programa, que esta en tu misma PC.
echo ============================================================
echo.
pause
exit /b 0

:descarga_fallo
echo.
echo No se pudo descargar el programa. Revisa que la PC tenga internet y
echo volve a ejecutar este archivo. Si sigue igual, contactanos.
echo.
pause
exit /b 1

:atajo_fallo
echo.
echo No se pudo dejar el programa para que arranque solo con Windows.
echo Contactanos con este mensaje.
echo.
pause
exit /b 1

:no_responde
echo.
echo El programa se instalo pero no contesta. Cerra esta ventana, espera
echo unos segundos y proba de nuevo desde el sistema. Si sigue igual,
echo contactanos.
echo.
pause
exit /b 1
