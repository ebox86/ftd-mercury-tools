@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BOOTSTRAP_PS1=%SCRIPT_DIR%bootstrap-opos-bridge.ps1"

if not exist "%BOOTSTRAP_PS1%" (
  echo [OPOS Bootstrap] bootstrap-opos-bridge.ps1 not found next to this .cmd file.
  echo Expected path: "%BOOTSTRAP_PS1%"
  pause
  exit /b 1
)

echo [OPOS Bootstrap] Running one-click install...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP_PS1%" -InstallRoot "C:\FTDTools\OposBridge" -LogicalName "ZEBRA_SCANNER" -Port 17331
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo [OPOS Bootstrap] Install failed with exit code %EXITCODE%.
  pause
  exit /b %EXITCODE%
)

echo [OPOS Bootstrap] Install complete.
pause
exit /b 0
