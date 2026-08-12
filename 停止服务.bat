@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "STOP_SCRIPT=%~dp0stop-infinite-canvas.ps1"
set "INFINITE_CANVAS_APP_DIR=%~dp0"
if not defined INFINITE_CANVAS_STOP_PORT set "INFINITE_CANVAS_STOP_PORT=3000"

if not exist "%STOP_SCRIPT%" goto missing_helper

powershell -NoProfile -ExecutionPolicy Bypass -Command "$code=[IO.File]::ReadAllText($env:STOP_SCRIPT,[Text.UTF8Encoding]::new($false)); & ([ScriptBlock]::Create($code)) -Port ([int]$env:INFINITE_CANVAS_STOP_PORT)"
set "STOP_RESULT=%ERRORLEVEL%"

echo.
if "%STOP_RESULT%"=="0" goto completed
if "%STOP_RESULT%"=="2" goto cancelled
goto failed

:missing_helper
echo Missing helper file: stop-infinite-canvas.ps1
set "STOP_RESULT=1"
goto failed

:completed
echo Done. Double-click 启动服务.bat when you want to start the service again.
goto finish

:cancelled
echo Cancelled. The service or another program is still running.
goto finish

:failed
echo Not completed. Please review the message above.

:finish
echo.
pause
exit /b %STOP_RESULT%
