@echo off
setlocal EnableExtensions DisableDelayedExpansion

if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm.cmd not found. Install Node.js and reopen terminal.
  exit /b 1
)

set "MODE="
set "PROXY_TARGET="
if not defined BRIDGE_PORT set "BRIDGE_PORT=17344"

if defined MERCURY_BASE_URL goto bridge_mode
if defined WORKFLOW_API_BASE_URL goto direct_mode

echo Set WORKFLOW_API_BASE_URL ^(direct /api host^) OR MERCURY_BASE_URL ^(SOAP host^).
exit /b 1

:bridge_mode
set "MODE=bridge"
if not defined MERCURY_SOAP_NAMESPACE set "MERCURY_SOAP_NAMESPACE=http://localhost/webservices/"
echo Starting workflow bridge server SOAP to /api/workflow...
start "live-bridge" cmd /k "set PORT=%BRIDGE_PORT%&&set MERCURY_BASE_URL=%MERCURY_BASE_URL%&&set MERCURY_SOAP_NAMESPACE=%MERCURY_SOAP_NAMESPACE%&&cd /d %~dp0workflow-bridge&&npm.cmd install&&npm.cmd start"
timeout /t 2 >nul
set "PROXY_TARGET=http://127.0.0.1:%BRIDGE_PORT%"
goto start_kiosk

:direct_mode
set "MODE=direct"
set "PROXY_TARGET=%WORKFLOW_API_BASE_URL%"
goto start_kiosk

:start_kiosk
echo Starting kiosk app...
start "kiosk-app" cmd /k "set VITE_WORKFLOW_PROXY_TARGET=%PROXY_TARGET%&&cd /d %~dp0kiosk-app&&npm.cmd install&&npm.cmd run dev -- --host"

echo Live dashboard boot started.
echo Kiosk UI:       http://127.0.0.1:5173
echo Workflow API:   %PROXY_TARGET%
if /I "%MODE%"=="bridge" (
  echo Mercury SOAP:   %MERCURY_BASE_URL%
  echo Bridge health:  http://127.0.0.1:%BRIDGE_PORT%/health
)

endlocal
exit /b 0

