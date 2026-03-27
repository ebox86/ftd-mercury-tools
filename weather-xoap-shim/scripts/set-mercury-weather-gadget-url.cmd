@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-mercury-weather-gadget-url.ps1" %*
exit /b %ERRORLEVEL%
