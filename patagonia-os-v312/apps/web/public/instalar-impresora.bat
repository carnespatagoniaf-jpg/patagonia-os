@echo off
setlocal

rem Instala el "programa de impresion" de Patagonia OS en esta PC (una sola vez).
rem Baja patagonia-print-agent.ps1 de este mismo sitio, lo deja arrancando con
rem Windows y lo prende ahora. No necesita ser administrador ni instalar
rem ningun driver. Para sacarlo: borrar el acceso directo "Patagonia OS -
rem impresion" de la carpeta Inicio de Windows (shell:startup).
rem
rem Ojo al editar:
rem - Sin etiquetas ni goto: Netlify sirve este archivo con saltos de linea LF y
rem   en un .bat con LF los saltos a etiquetas pueden fallar.
rem - Los parentesis dentro de un echo de un bloque if rompen el .bat.

echo Instalando el programa de impresion de Patagonia OS...
echo.

set "DIR=%LocalAppData%\PatagoniaOS"
if not exist "%DIR%" mkdir "%DIR%"
set "AGENT=%DIR%\patagonia-print-agent.ps1"
rem Se baja a un archivo aparte y recien si es el programa de verdad se reemplaza
rem el instalado: una descarga mala no puede dejar roto el que ya andaba.
set "AGENT_NEW=%DIR%\patagonia-print-agent.ps1.descarga"

echo 1/4 Descargando el programa...
if exist "%AGENT_NEW%" del "%AGENT_NEW%"
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://app.patagoniasystem.com.ar/patagonia-print-agent.ps1' -OutFile $env:AGENT_NEW -UseBasicParsing } catch { exit 1 }"
set "DL_OK=1"
if %ERRORLEVEL% NEQ 0 set "DL_OK=0"
if not exist "%AGENT_NEW%" set "DL_OK=0"
rem Si el sitio o el WiFi devolvio una pagina en vez del programa, no seguir.
if "%DL_OK%"=="1" findstr /b /c:"# Patagonia OS" "%AGENT_NEW%" >nul
if "%DL_OK%"=="1" if errorlevel 1 set "DL_OK=0"
if "%DL_OK%"=="0" (
    if exist "%AGENT_NEW%" del "%AGENT_NEW%"
    echo.
    echo No se pudo descargar el programa. Revisa que la PC tenga internet y
    echo volve a ejecutar este archivo. Si sigue igual, contactanos.
    echo.
    pause
    exit /b 1
)

echo 2/4 Frenando la version anterior, si habia...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*patagonia-print-agent*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
move /y "%AGENT_NEW%" "%AGENT%" >nul
if errorlevel 1 (
    echo.
    echo No se pudo guardar el programa en la carpeta PatagoniaOS. Contactanos.
    echo.
    pause
    exit /b 1
)

echo 3/4 Dejandolo para que arranque solo con Windows...
powershell -NoProfile -Command "$q = [char]34; $s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\Patagonia OS - impresion.lnk'); $s.TargetPath = 'powershell.exe'; $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $q + $env:AGENT + $q; $s.WindowStyle = 7; $s.Description = 'Patagonia OS - programa de impresion de tickets'; $s.Save()"
if errorlevel 1 (
    echo.
    echo No se pudo dejar el programa para que arranque solo con Windows.
    echo Contactanos con este mensaje.
    echo.
    pause
    exit /b 1
)

echo 4/4 Prendiendolo ahora...
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%AGENT%"

rem Al arrancar el programa se prepara unos segundos (mas en una PC lenta):
rem se reintenta hasta 30 segundos antes de decir que no contesta.
powershell -NoProfile -Command "for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 3; try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9101/ping' -TimeoutSec 4; if ($r.ok) { exit 0 } } catch { } }; exit 1"
if errorlevel 1 (
    echo.
    echo El programa se instalo pero no contesta. Cerra esta ventana, espera
    echo unos segundos y proba de nuevo desde el sistema. Si sigue igual,
    echo contactanos.
    echo.
    pause
    exit /b 1
)

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
