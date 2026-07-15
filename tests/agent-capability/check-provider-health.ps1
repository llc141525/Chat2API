param(
    [string[]]$Models = @(),

    [string]$OutputPath = ".agent-probe/provider-health.json",

    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    exit 1
}

function Get-OpencodeConfigPath() {
    $candidates = @(
        (Join-Path $HOME ".config\opencode\opencode.json"),
        (Join-Path $HOME ".config\opencode\opencode.jsonc"),
        ".\opencode.json",
        ".\opencode.jsonc"
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) {
            return (Resolve-Path $path).Path
        }
    }

    return ""
}

function Get-ProviderName([string]$ModelName) {
    $parts = $ModelName.Split("/", 2)
    if ($parts.Length -lt 2) {
        return ""
    }

    return $parts[0]
}

function Get-ModelName([string]$ModelName) {
    $parts = $ModelName.Split("/", 2)
    if ($parts.Length -lt 2) {
        return $ModelName
    }

    return $parts[1]
}

function Get-Classification([string]$Status, [string]$Detail) {
    if ($Status -eq "ok" -and $Detail -match '模型名称错误|model.+not found|unknown model|model.+unavailable') {
        return "model_unavailable"
    }
    if ($Status -eq "ok" -and $Detail -match 'Error:|错误|刷新页面|重试|try again') {
        return "provider_unavailable"
    }
    if ($Status -eq "ok") {
        return "healthy"
    }
    if ($Detail -match '429|rate.?limit|too many requests|限流') {
        return "provider_rate_limited"
    }
    if ($Detail -match '401|403|unauthorized|forbidden|auth|token|登录') {
        return "auth_or_login_failed"
    }
    if ($Detail -match 'timeout|timed out|canceled') {
        return "provider_timeout"
    }
    if ($Detail -match 'model.+not found|unknown model|模型名称错误|404') {
        return "model_unavailable"
    }
    return "provider_unavailable"
}

function Get-ConfiguredModels($Config) {
    $configured = @()
    foreach ($providerProperty in $Config.provider.PSObject.Properties) {
        $providerName = $providerProperty.Name
        $provider = $providerProperty.Value
        foreach ($modelProperty in $provider.models.PSObject.Properties) {
            $configured += "$providerName/$($modelProperty.Name)"
        }
    }
    return $configured
}

$configPath = Get-OpencodeConfigPath
if ([string]::IsNullOrWhiteSpace($configPath)) {
    Fail "opencode config not found"
}

$config = Get-Content -Raw $configPath | ConvertFrom-Json
$modelList = if ($Models.Count -gt 0) { $Models } else { Get-ConfiguredModels $config }
$results = New-Object System.Collections.Generic.List[object]

New-Item -ItemType Directory -Force -Path (Split-Path $OutputPath -Parent) | Out-Null

foreach ($model in $modelList) {
    $providerName = Get-ProviderName $model
    $modelName = Get-ModelName $model
    $providerConfig = $config.provider.$providerName
    $status = "fail"
    $detail = ""
    $classification = "provider_unavailable"
    $elapsedMs = 0

    if ($null -eq $providerConfig) {
        $detail = "provider '$providerName' is not configured"
        $classification = "provider_unavailable"
    } else {
        $baseUrl = [string]$providerConfig.options.baseURL
        $apiKey = [string]$providerConfig.options.apiKey
        $body = @{
            model = $model
            stream = $false
            messages = @(@{ role = "user"; content = "只回复 OK" })
        } | ConvertTo-Json -Depth 10

        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            $response = Invoke-RestMethod -Method Post -Uri ($baseUrl.TrimEnd("/") + "/chat/completions") -Headers @{
                Authorization = "Bearer $apiKey"
                "Content-Type" = "application/json"
            } -Body $body -TimeoutSec $TimeoutSeconds

            $status = "ok"
            if ($response.choices -and $response.choices.Count -gt 0 -and $response.choices[0].message) {
                $detail = [string]$response.choices[0].message.content
            } else {
                $detail = ($response | ConvertTo-Json -Compress -Depth 20)
            }
        } catch {
            $detail = $_.Exception.Message
            if ($_.ErrorDetails.Message) {
                $detail = $_.ErrorDetails.Message
            }
            if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
                $detail = $detail -replace [regex]::Escape($apiKey), "<redacted>"
            }
        } finally {
            $sw.Stop()
            $elapsedMs = $sw.ElapsedMilliseconds
        }

        $classification = Get-Classification $status $detail
    }

    $results.Add([pscustomobject][ordered]@{
        provider = $providerName
        model = $modelName
        modelId = $model
        status = $status
        classification = $classification
        elapsedMs = $elapsedMs
        detail = if ($detail.Length -gt 500) { $detail.Substring(0, 500) } else { $detail }
    }) | Out-Null
}

[System.IO.File]::WriteAllText(
    $OutputPath,
    ($results | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
)

$results |
    Select-Object provider, model, status, classification, elapsedMs, detail |
    Format-Table -AutoSize

Write-Host "PROVIDER_HEALTH_WRITTEN $OutputPath"

if (($results | Where-Object { $_.classification -eq "healthy" }).Count -eq 0) {
    Write-Host "PROVIDER_HEALTH_NO_HEALTHY_MODELS"
    exit 1
}

Write-Host "PROVIDER_HEALTH_PASS"
