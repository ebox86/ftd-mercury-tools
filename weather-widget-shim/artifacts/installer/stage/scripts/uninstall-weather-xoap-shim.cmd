@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-weather-xoap-shim.ps1" %*
exit /b %ERRORLEVEL%
