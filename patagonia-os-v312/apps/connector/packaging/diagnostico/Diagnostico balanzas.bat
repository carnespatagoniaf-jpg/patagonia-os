@echo off
rem Diagnostico de balanzas: pide permiso de administrador (para leer la carpeta del servicio) y deja un .zip en el Escritorio.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostico-scale-connect.ps1"
echo.
pause
