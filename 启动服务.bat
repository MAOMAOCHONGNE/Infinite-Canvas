@echo off
cd /d "%~dp0"

set "PYEXE=%~dp0python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"
set "APP_PORT=3000"

powershell -NoProfile -Command "$listener=Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue; if(-not $listener){exit 0}; try{$response=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%APP_PORT%/api/config' -TimeoutSec 2; if($response.StatusCode -eq 200){exit 11}}catch{}; exit 10"
if errorlevel 11 goto already_running
if errorlevel 10 goto port_in_use

echo Starting ComfyUI-API-Modelscope...
echo Press Ctrl+C to stop.
echo.

start /b cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:%APP_PORT%/"
"%PYEXE%" main.py

echo.
echo Server stopped.
pause
exit /b

:already_running
echo Infinite Canvas is already running on port %APP_PORT%.
echo Opening the existing service instead of starting a duplicate.
start "" "http://127.0.0.1:%APP_PORT%/"
pause
exit /b 0

:port_in_use
echo Port %APP_PORT% is occupied by another program.
echo Run stop service first, or inspect the program using this port.
pause
exit /b 10
