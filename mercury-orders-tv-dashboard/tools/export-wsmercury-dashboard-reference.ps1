[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://localhost/WsMercuryWebAPI',
    [string]$OutDir = '..\reference'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDirResolved = [System.IO.Path]::GetFullPath((Join-Path $scriptDir $OutDir))
New-Item -ItemType Directory -Force -Path $outDirResolved | Out-Null

function Get-ServiceOperations {
    param([string]$BaseUrl)

    $results = @()
    $servicePath = 'C:\Wings\Web\WsMercuryWebAPI'
    $files = Get-ChildItem -Path $servicePath -Filter *.asmx -ErrorAction Stop

    foreach ($file in $files) {
        $name = $file.BaseName
        $url = "$BaseUrl/$name.asmx"

        try {
            $content = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).Content
            $ops = [regex]::Matches($content, '\?op=([^"&]+)') |
                ForEach-Object { $_.Groups[1].Value } |
                Sort-Object -Unique

            if ($ops -is [string]) {
                $ops = @($ops)
            }

            $results += [pscustomobject]@{
                service = $name
                op_count = ($ops | Measure-Object | Select-Object -ExpandProperty Count)
                operations = @($ops)
            }
        }
        catch {
            $results += [pscustomobject]@{
                service = $name
                op_count = -1
                operations = @("ERROR: $($_.Exception.Message)")
            }
        }
    }

    return $results | Sort-Object service
}

function Get-DashboardContract {
    param([string]$BaseUrl)

    $base = "$BaseUrl/dashboard.asmx"
    $svcHtml = (Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 20).Content
    $ops = [regex]::Matches($svcHtml, '\?op=([^"&]+)') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique

    $methods = @()
    foreach ($op in $ops) {
        $opUrl = "${base}?op=$op"
        $opHtml = (Invoke-WebRequest -Uri $opUrl -UseBasicParsing -TimeoutSec 20).Content

        $params = [regex]::Matches($opHtml, '<input[^>]*name="([^"]+)"[^>]*>') |
            ForEach-Object { $_.Groups[1].Value } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique

        if ($params -is [string]) {
            $params = @($params)
        }

        $resultKind = 'dataset:DashboardEventDataset'
        if ($op -in @('GetDashboardEnabled', 'MarkMessageRead', 'DeleteMarketingMessages')) {
            $resultKind = 'boolean'
        }
        elseif ($op -eq 'GetWeatherGadgetRefreshTime') {
            $resultKind = 'int'
        }
        elseif ($op -eq 'PublishDashboardEventType') {
            $resultKind = 'enum-string'
        }
        elseif ($op -eq 'GetStates') {
            $resultKind = 'dataset:StatesDataSet'
        }
        elseif ($op -eq 'GetMarketingMessages') {
            $resultKind = 'dataset:MarketingMessageDataset'
        }

        $methods += [pscustomobject]@{
            name = $op
            params = @($params)
            result_kind = $resultKind
            http_post_path = "/WsMercuryWebAPI/dashboard.asmx/$op"
        }
    }

    function Get-SchemaMap {
        param([string]$schemaName)

        $schemaUrl = "${base}?schema=$schemaName"
        $xml = [xml](Invoke-WebRequest -Uri $schemaUrl -UseBasicParsing -TimeoutSec 20).Content
        $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
        $ns.AddNamespace('xs', 'http://www.w3.org/2001/XMLSchema')

        $tableNodes = $xml.SelectNodes('//xs:element/xs:complexType/xs:choice/xs:element', $ns)
        $map = [ordered]@{}

        foreach ($t in $tableNodes) {
            $tableName = $t.GetAttribute('name')
            $cols = $t.SelectNodes('xs:complexType/xs:sequence/xs:element', $ns) |
                ForEach-Object { $_.GetAttribute('name') }
            $map[$tableName] = @($cols)
        }

        return $map
    }

    $schemas = [ordered]@{
        DashboardEventDataset = (Get-SchemaMap 'DashboardEventDataset')
        StatesDataSet = (Get-SchemaMap 'StatesDataSet')
        MarketingMessageDataset = (Get-SchemaMap 'MarketingMessageDataset')
    }

    $eventTypes = @(
        'DashboardEnabled',
        'PollingInterval',
        'MercuryMessages',
        'DeclinedCreditCard',
        'UnauthorizedCreditCard',
        'CODOrders',
        'PickupOrders',
        'IncompleteOrPendingOrders',
        'FiledOrders',
        'UnableToAccessMercuryInternet',
        'ProtocolsUnavailable',
        'BackupStatus',
        'NotDeliveredOrders',
        'StoreMainCode',
        'LastOrderSequenceNumber',
        'MercuryMessageAlert',
        'InternetConnectionStatus',
        'MobileAppEnabled'
    )

    $config = [ordered]@{}
    try {
        $rows = sqlcmd -S localhost -d STORE -W -s '|' -h -1 -Q "SET NOCOUNT ON; SELECT NAME, SETTING_VALUE FROM FTD.CONFIG_SETTING WHERE CONFIG_GROUP_ID = 14 AND NAME IN ('DashboardEnabled','DashboardPollingInterval','DashboardCCDisplayLimit','WeatherGadgetRefreshTimer','WeatherChannelPartnerID','WeatherChannelLicenseKey') ORDER BY NAME;"
        foreach ($line in $rows) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split '\|', 2
            if ($parts.Count -eq 2) {
                $config[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
    }
    catch {
        $config['error'] = 'Unable to query config settings: ' + $_.Exception.Message
    }

    return [ordered]@{
        generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        service = 'DashboardService'
        endpoint = $base
        target_namespace = 'http://localhost/webservices/'
        methods = @($methods)
        schemas = $schemas
        enum_dashboard_event_type = $eventTypes
        config_group_14_dashboard_weather_settings = $config
    }
}

$ops = Get-ServiceOperations -BaseUrl $BaseUrl
$ops | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $outDirResolved 'wsmercury-service-operations.json') -Encoding UTF8

$dash = Get-DashboardContract -BaseUrl $BaseUrl
$dash | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outDirResolved 'dashboard-service-contract.json') -Encoding UTF8

Write-Host "Export complete: $outDirResolved"
