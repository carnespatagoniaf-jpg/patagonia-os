@echo off
setlocal

echo Configurando el modo kiosco para imprimir tickets sin dialogo...
echo.

set "CHROME_PATH="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if "%CHROME_PATH%"=="" (
    echo No se encontro Chrome instalado en las carpetas habituales de esta PC.
    echo Si tenes Chrome instalado en otro lugar, contactanos con la ruta exacta.
    pause
    exit /b 1
)

echo Chrome encontrado en: %CHROME_PATH%
echo.

set "ICON_DIR=%LocalAppData%\PatagoniaOS"
if not exist "%ICON_DIR%" mkdir "%ICON_DIR%"
set "ICON_PATH=%ICON_DIR%\patagonia-icon.ico"

echo Descargando el logo...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://app.patagoniasystem.com.ar/patagonia-icon.ico' -OutFile '%ICON_PATH%' -UseBasicParsing } catch { exit 1 }"
if not exist "%ICON_PATH%" set "ICON_PATH=%CHROME_PATH%"

powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%USERPROFILE%\Desktop\Patagonia OS (Kiosco).lnk');" ^
  "$s.TargetPath = '%CHROME_PATH%';" ^
  "$s.Arguments = '--kiosk-printing https://app.patagoniasystem.com.ar';" ^
  "$s.IconLocation = '%ICON_PATH%';" ^
  "$s.Description = 'Patagonia OS - Mostrador con impresion automatica de tickets';" ^
  "$s.Save()"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Algo fallo al crear el acceso directo. Contactanos con el mensaje de arriba.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo LISTO. Se creo el acceso directo "Patagonia OS (Kiosco)" en
echo el Escritorio.
echo.
echo IMPORTANTE - antes de usarlo:
echo Cerra TODAS las ventanas de Chrome que tengas abiertas ahora
echo (y si queda alguna en el Administrador de tareas, finalizala) --
echo el modo kiosco solo funciona si Chrome arranca de cero con este
echo acceso directo, no si ya estaba abierto.
echo.
echo A partir de ahora, usa SIEMPRE este acceso directo (no el
echo icono normal de Chrome) para entrar al sistema en esta PC --
echo asi el ticket sale solo al cobrar, sin ningun dialogo.
echo.
echo Un paso mas, a mano:
echo En Windows, anda a Configuracion - Impresoras y escaneres,
echo hace clic en tu impresora y elegi "Establecer como predeterminada".
echo El modo kiosco siempre imprime en la impresora predeterminada
echo de Windows, sin dejarte elegir otra.
echo ============================================================
echo.
pause
