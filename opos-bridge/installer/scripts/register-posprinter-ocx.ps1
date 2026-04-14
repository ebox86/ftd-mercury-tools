# Registers OPOSPOSPrinter.ocx for Star POS printer support
$ocxPath = Join-Path $PSScriptRoot "..\assets\OPOSPOSPrinter.ocx"
if (Test-Path $ocxPath) {
    Start-Process -FilePath "regsvr32.exe" -ArgumentList "/s", $ocxPath -Wait -NoNewWindow
} else {
    Write-Error "OPOSPOSPrinter.ocx not found at $ocxPath"
}
