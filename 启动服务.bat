@echo off
setlocal
cd /d "%~dp0"

set "PYEXE=%~dp0python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"
set "APP_PORT=3000"
set "STOP_SCRIPT=%~dp0stop-infinite-canvas.ps1"
set "INFINITE_CANVAS_APP_DIR=%~dp0"

powershell -NoProfile -Command "$listener=Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue; if($listener){exit 10}; exit 0"
set "PORT_CHECK_RESULT=%ERRORLEVEL%"
if "%PORT_CHECK_RESULT%"=="10" goto clear_port
if not "%PORT_CHECK_RESULT%"=="0" goto port_check_failed
goto start_server

:clear_port
echo Port %APP_PORT% is occupied. Stopping the exact listener before startup...
if not exist "%STOP_SCRIPT%" goto missing_helper
powershell -NoProfile -ExecutionPolicy Bypass -Command "$code=[IO.File]::ReadAllText($env:STOP_SCRIPT,[Text.UTF8Encoding]::new($false)); & ([ScriptBlock]::Create($code)) -Port ([int]$env:APP_PORT) -ForcePortOwner -MaxAttempts 3"
set "CLEAR_RESULT=%ERRORLEVEL%"
if not "%CLEAR_RESULT%"=="0" goto cleanup_failed

powershell -NoProfile -Command "$listener=Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue; if($listener){exit 10}; exit 0"
set "PORT_VERIFY_RESULT=%ERRORLEVEL%"
if not "%PORT_VERIFY_RESULT%"=="0" goto cleanup_failed

:start_server
echo Starting ComfyUI-API-Modelscope...
echo Press Ctrl+C to stop.
echo.

start /b cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:%APP_PORT%/"
"%PYEXE%" main.py

echo.
echo Server stopped.
pause
exit /b

:missing_helper
echo Missing helper file: stop-infinite-canvas.ps1
pause
exit /b 1

:cleanup_failed
echo.
echo Port %APP_PORT% could not be released. The new service was not started.
echo Review the process details above or run this launcher as administrator.
pause
exit /b 1

:port_check_failed
echo.
echo Unable to inspect port %APP_PORT%. The service was not started.
echo Run this launcher as administrator and try again.
pause
exit /b 1
