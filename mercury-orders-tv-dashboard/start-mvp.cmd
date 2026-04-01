@echo off
setlocal

if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm.cmd not found. Install Node.js and reopen terminal.
  exit /b 1
)
if not defined BRIDGE_PORT set "BRIDGE_PORT=17344"

echo Starting Mercury workflow bridge...
start "workflow-bridge" cmd /k "set PORT=%BRIDGE_PORT%&&cd /d %~dp0workflow-bridge && npm.cmd install && npm.cmd start"

timeout /t 2 >nul

echo Starting kiosk app...
start "kiosk-app" cmd /k "cd /d %~dp0kiosk-app && npm.cmd install && npm.cmd run dev -- --host"

echo MVP boot started.
echo Workflow API: http://127.0.0.1:%BRIDGE_PORT%/health
echo Kiosk UI: http://127.0.0.1:5173

endlocal

