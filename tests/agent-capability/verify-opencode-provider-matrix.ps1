param(
    [Parameter(Mandatory = $true)]
    [string[]]$Models,

    [int]$Runs = 3,

    [string]$ProbeScript = ".\tests\agent-capability\verify-opencode-capability.ps1",

    [string]$ResultsRoot = ".\tests\agent-capability\results"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    Write-Host "PROVIDER_MATRIX_FAIL"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function Get-ProviderName([string]$Model) {
    $parts = $Model.Split("/", 2)
    if ($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[0])) {
        return "unknown"
    }
    return $parts[0].ToLowerInvariant()
}

function Get-Slug([string]$Value) {
    return ($Value -replace '[^A-Za-z0-9._-]+', '_')
}

function Get-Classification([string]$OutputText) {
    if ($OutputText -match 'captcha|risk.?control|风控|验证') {
        return "provider_risk_control"
    }
    if ($OutputText -match 'auth|token|unauthorized|forbidden|401|403|登录') {
        return "auth_expired"
    }
    if ($OutputText -match 'provider_preflight_failed|rate.?limit|429|too many requests|限流') {
        return "provider_unavailable"
    }
    if ($OutputText -match 'model.+unavailable|unknown model|模型.+不可用|not found|404') {
        return "model_unavailable"
    }
    if ($OutputText -match 'malformed tool output|malformed_tool_output') {
        return "malformed_tool_output"
    }
    if ($OutputText -match 'catalog_availability_drift|summary_contamination|provider refused the authoritative tool catalog') {
        return "catalog_availability_drift"
    }
    if ($OutputText -match 'swallowed reply|Missing \.agent-probe/result\.json|No real skill tool call|CAPABILITY_PROBE_FAIL') {
        return "swallowed_reply"
    }
    if ($OutputText -match 'CAPABILITY_PROBE_PASS') {
        return "accepted"
    }
    return "swallowed_reply"
}

function Copy-IfExists([string]$Source, [string]$Destination) {
    if (Test-Path $Source) {
        Copy-Item -Force $Source $Destination
    }
}

if ($Runs -lt 1) {
    Fail "Runs must be >= 1"
}

if (-not (Test-Path $ProbeScript)) {
    Fail "Probe script not found: $ProbeScript"
}

New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null

$allSummaries = New-Object System.Collections.Generic.List[object]
$acceptedFailures = New-Object System.Collections.Generic.List[string]

Write-Host "============================================"
Write-Host " Chat2API Provider Matrix Probe"
Write-Host " Models: $($Models -join ', ')"
Write-Host " Runs  : $Runs"
Write-Host "============================================"

foreach ($model in $Models) {
    $provider = Get-ProviderName $model
    $modelSlug = Get-Slug $model
    $providerRoot = Join-Path $ResultsRoot $provider
    New-Item -ItemType Directory -Force -Path $providerRoot | Out-Null

    for ($run = 1; $run -le $Runs; $run++) {
        $runId = "{0}__run{1}" -f $modelSlug, $run
        $runDir = Join-Path $providerRoot $runId
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null

        Write-Host "--------------------------------------------"
        Write-Host " Provider: $provider"
        Write-Host " Model   : $model"
        Write-Host " Run     : $run/$Runs"
        Write-Host "--------------------------------------------"

        $stdoutPath = Join-Path $runDir "probe-stdout.txt"
        $stderrPath = Join-Path $runDir "probe-stderr.txt"
        $summaryPath = Join-Path $runDir "verifier-summary.json"

        $output = & powershell -ExecutionPolicy Bypass -File $ProbeScript -Model $model 2>&1
        $exitCode = $LASTEXITCODE
        $outputText = ($output -join [Environment]::NewLine)
        $outputText | Out-File -FilePath $stdoutPath -Encoding utf8
        "" | Out-File -FilePath $stderrPath -Encoding utf8

        $classification = Get-Classification $outputText
        $accepted = ($classification -eq "accepted" -and $exitCode -eq 0)

        $resultCopy = Join-Path $runDir "result.json"
        $eventsCopy = Join-Path $runDir "opencode-events.ndjson"
        $devLogCopy = Join-Path $runDir "redacted-dev-log.txt"

        Copy-IfExists ".\.agent-probe\result.json" $resultCopy
        Copy-IfExists ".\.agent-probe\opencode-events.ndjson" $eventsCopy
        if (Test-Path ".\dev.log") {
            Get-Content ".\dev.log" -Tail 400 | Out-File -FilePath $devLogCopy -Encoding utf8
        }

        $summary = [ordered]@{
            provider = $provider
            model = $model
            run = $run
            exitCode = $exitCode
            classification = $classification
            accepted = $accepted
            probeScript = $ProbeScript
            artifacts = [ordered]@{
                stdout = $stdoutPath
                stderr = $stderrPath
                result = $(if (Test-Path $resultCopy) { $resultCopy } else { $null })
                events = $(if (Test-Path $eventsCopy) { $eventsCopy } else { $null })
                devLog = $(if (Test-Path $devLogCopy) { $devLogCopy } else { $null })
            }
        }

        [System.IO.File]::WriteAllText(
            $summaryPath,
            ($summary | ConvertTo-Json -Depth 20),
            [System.Text.UTF8Encoding]::new($false)
        )
        $allSummaries.Add($summary) | Out-Null

        if ($accepted) {
            Pass "$model run $run classified as accepted"
        } else {
            Write-Host "[WARN] $model run $run classified as $classification (exit $exitCode)"
            $acceptedFailures.Add("$model run $run => $classification") | Out-Null
        }
    }
}

$aggregatePath = Join-Path $ResultsRoot "provider-matrix-summary.json"
[System.IO.File]::WriteAllText(
    $aggregatePath,
    ($allSummaries | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
)
Pass "Wrote aggregate summary to $aggregatePath"

if ($acceptedFailures.Count -gt 0) {
    Write-Host "[WARN] Non-accepted runs:"
    foreach ($failure in $acceptedFailures) {
        Write-Host " - $failure"
    }
    Write-Host "PROVIDER_MATRIX_PARTIAL"
    exit 1
}

Write-Host "PROVIDER_MATRIX_PASS"
exit 0
