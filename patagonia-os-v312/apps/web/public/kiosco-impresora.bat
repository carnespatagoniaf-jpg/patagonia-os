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
echo Registrando el tamano de papel del rollo (Rollo80mm) en Windows...

set "FORM_SCRIPT=%TEMP%\patagonia-kiosco-form.ps1"
if exist "%FORM_SCRIPT%" del "%FORM_SCRIPT%"

echo Add-Type -TypeDefinition @' >> "%FORM_SCRIPT%"
echo using System; >> "%FORM_SCRIPT%"
echo using System.Runtime.InteropServices; >> "%FORM_SCRIPT%"
echo public class PatagoniaPrinterForm { >> "%FORM_SCRIPT%"
echo   [StructLayout(LayoutKind.Sequential)] public struct SIZEL { public int cx; public int cy; } >> "%FORM_SCRIPT%"
echo   [StructLayout(LayoutKind.Sequential)] public struct RECTL { public int left; public int top; public int right; public int bottom; } >> "%FORM_SCRIPT%"
echo   [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct FORM_INFO_1 { public int Flags; public string pName; public SIZEL Size; public RECTL ImageableArea; } >> "%FORM_SCRIPT%"
echo   [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault); >> "%FORM_SCRIPT%"
echo   [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr hPrinter); >> "%FORM_SCRIPT%"
echo   [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool AddForm(IntPtr hPrinter, int Level, ref FORM_INFO_1 pForm); >> "%FORM_SCRIPT%"
echo } >> "%FORM_SCRIPT%"
echo '@ >> "%FORM_SCRIPT%"
echo $hPrinter = [IntPtr]::Zero >> "%FORM_SCRIPT%"
echo $serverName = "\\" + $env:COMPUTERNAME >> "%FORM_SCRIPT%"
echo if (-not [PatagoniaPrinterForm]::OpenPrinter($serverName, [ref]$hPrinter, [IntPtr]::Zero)) { Write-Host "NOOK"; exit 1 } >> "%FORM_SCRIPT%"
echo $form = New-Object PatagoniaPrinterForm+FORM_INFO_1 >> "%FORM_SCRIPT%"
echo $form.Flags = 0 >> "%FORM_SCRIPT%"
echo $form.pName = "Rollo80mm" >> "%FORM_SCRIPT%"
echo $form.Size = New-Object PatagoniaPrinterForm+SIZEL -Property @{ cx = 80000; cy = 210000 } >> "%FORM_SCRIPT%"
echo $form.ImageableArea = New-Object PatagoniaPrinterForm+RECTL -Property @{ left = 0; top = 0; right = 80000; bottom = 210000 } >> "%FORM_SCRIPT%"
echo $ok = [PatagoniaPrinterForm]::AddForm($hPrinter, 1, [ref]$form) >> "%FORM_SCRIPT%"
echo [PatagoniaPrinterForm]::ClosePrinter($hPrinter) ^| Out-Null >> "%FORM_SCRIPT%"
echo if ($ok) { Write-Host "OK" } else { Write-Host "NOOK" } >> "%FORM_SCRIPT%"

set "FORM_RESULT="
for /f %%r in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%FORM_SCRIPT%" 2^>nul') do set "FORM_RESULT=%%r"
del "%FORM_SCRIPT%" >nul 2>&1

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
if "%FORM_RESULT%"=="OK" (
    echo El tamano de papel "Rollo80mm" ^(80 x 210mm, para el rollo de
    echo la impresora termica^) ya quedo registrado en Windows, sin que
    echo tengas que crear nada a mano.
) else (
    echo No se pudo registrar el tamano de papel del rollo solo -- lo
    echo tenes que crear a mano UNA vez: Panel de control - Dispositivos
    echo e impresoras - clic en cualquier impresora - "Propiedades del
    echo servidor de impresion" - pestana "Formularios" - "Crear un nuevo
    echo formulario" - nombre Rollo80mm, Ancho 80mm, Alto 210mm - Guardar.
)
echo.
echo Un paso mas, a mano (este si es imprescindible):
echo 1) Configuracion - Impresoras y escaneres (o Panel de control -
echo    Dispositivos e impresoras), clic en tu impresora termica y
echo    elegi "Establecer como predeterminada".
echo 2) Clic derecho sobre esa misma impresora - "Preferencias de
echo    impresion" - elegi el tamano de papel "Rollo80mm" - Aceptar.
echo El modo kiosco siempre imprime con la impresora y el tamano de
echo papel que hayan quedado configurados como predeterminados.
echo ============================================================
echo.
pause
