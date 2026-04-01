@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0smoke-test-weather-xoap-shim.ps1" %*
exit /b %ERRORLEVEL%
