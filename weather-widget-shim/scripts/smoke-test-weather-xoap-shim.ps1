[CmdletBinding()]
param(
    [string]$HostName = 'xoap.weather.com'
)

$ErrorActionPreference = 'Stop'

$searchUrl = "http://$HostName/search/search?where=lisle,il"
$weatherUrl = "http://$HostName/weather/local/60515?cc=*&dayf=5&prod=xoap&par=test&key=test"

Write-Host "GET $searchUrl"
$search = Invoke-WebRequest -Uri $searchUrl -UseBasicParsing -TimeoutSec 20
Write-Host "Status: $($search.StatusCode)"
Write-Host ($search.Content.Substring(0, [Math]::Min(250, $search.Content.Length)))

Write-Host "`nGET $weatherUrl"
$weather = Invoke-WebRequest -Uri $weatherUrl -UseBasicParsing -TimeoutSec 20
Write-Host "Status: $($weather.StatusCode)"
Write-Host ($weather.Content.Substring(0, [Math]::Min(400, $weather.Content.Length)))

if ($search.StatusCode -ne 200 -or $weather.StatusCode -ne 200) {
    throw 'Shim smoke test failed.'
}

Write-Host "`nSmoke test passed."
