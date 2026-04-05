[CmdletBinding()]
param(
    [string]$HostName = 'xoap.weather.com'
)

$ErrorActionPreference = 'Stop'

$searchUrl = "http://$HostName/search/search?where=lisle,il"
$weatherUrl = "http://$HostName/weather/local/60515?cc=*&dayf=5&prod=xoap&par=test&key=test"

function Assert-XoapShape {
    param(
        [string]$Name,
        $Response,
        [string]$RequiredNode
    )

    if ($Response.StatusCode -ne 200) {
        throw "$Name endpoint returned HTTP $($Response.StatusCode) instead of 200."
    }

    $content = [string]$Response.Content
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "$Name endpoint returned empty content."
    }

    if ($content -notmatch [regex]::Escape($RequiredNode)) {
        throw "$Name endpoint did not return expected XOAP XML marker '$RequiredNode'."
    }
}

Write-Host "GET $searchUrl"
$search = Invoke-WebRequest -Uri $searchUrl -UseBasicParsing -TimeoutSec 20
Write-Host "Status: $($search.StatusCode)"
Write-Host ($search.Content.Substring(0, [Math]::Min(250, $search.Content.Length)))
Assert-XoapShape -Name 'search' -Response $search -RequiredNode '<search'

Write-Host "`nGET $weatherUrl"
$weather = Invoke-WebRequest -Uri $weatherUrl -UseBasicParsing -TimeoutSec 20
Write-Host "Status: $($weather.StatusCode)"
Write-Host ($weather.Content.Substring(0, [Math]::Min(400, $weather.Content.Length)))
Assert-XoapShape -Name 'weather' -Response $weather -RequiredNode '<weather'

Write-Host "`nSmoke test passed."
