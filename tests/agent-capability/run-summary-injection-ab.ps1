param(
    [string[]]$Models = @("qwen/Qwen3.7-Max", "glm/GLM-5.2"),

    [string]$LogPath = ".\dev.log",

    [string]$PromptPath = "tests/agent-capability/long-conversation-contamination.md",

    [string]$OutputDir = "tests/agent-capability/results/summary-injection-runs",

    [int]$RunsPerVariant = 1
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function Sanitize-Name([string]$Value) {
    return ($Value -replace '[^A-Za-z0-9._-]', '_')
}

function Read-Json([string]$Path) {
    return Get-Content -Raw $Path | ConvertFrom-Json
}

if (-not (Test-Path $PromptPath)) { Fail "Prompt file not found: $PromptPath" }
if (-not (Test-Path $LogPath)) { Fail "Log file not found: $LogPath" }
if (-not (Test-Path "tests/agent-capability/verify-opencode-long-conversation.ps1")) {
    Fail "Missing verifier script"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$summary = New-Object System.Collections.Generic.List[object]

foreach ($model in $Models) {
    for ($run = 1; $run -le $RunsPerVariant; $run++) {
        $modelSlug = Sanitize-Name $model
        $variantDir = Join-Path $OutputDir "system-isolated__$($modelSlug)__run$run"
        if (Test-Path $variantDir) {
            Remove-Item -Recurse -Force $variantDir
        }

        Write-Host "============================================"
        Write-Host " Summary contamination probe"
        Write-Host " Shape: system-isolated"
        Write-Host " Model: $model"
        Write-Host " Run:   $run/$RunsPerVariant"
        Write-Host "============================================"

        & powershell -ExecutionPolicy Bypass -File ".\tests\agent-capability\verify-opencode-long-conversation.ps1" `
            -Model $model `
            -LogPath $LogPath `
            -PromptPath $PromptPath
        $exitCode = $LASTEXITCODE

        $probeSnapshot = Join-Path $variantDir "probe"
        New-Item -ItemType Directory -Force -Path $probeSnapshot | Out-Null
        if (Test-Path ".agent-probe") {
            Copy-Item -Recurse -Force ".agent-probe\*" $probeSnapshot
        }

        $eventsPath = Join-Path $probeSnapshot "opencode-long-events.ndjson"
        $metaPath = Join-Path $probeSnapshot "long-meta.json"
        $eventText = if (Test-Path $eventsPath) { Get-Content -Raw $eventsPath } else { "" }
        $meta = if (Test-Path $metaPath) { Read-Json $metaPath } else { $null }

        $row = [pscustomobject]@{
            model = $model
            shape = "system-isolated"
            run = $run
            exitCode = $exitCode
            pass = ($exitCode -eq 0)
            summaryContaminationMentions = ([regex]::Matches($eventText, 'summary_contamination', 'IgnoreCase')).Count
            fabricatedToolMentions = ([regex]::Matches($eventText, 'Burp Suite MCP|GitHub Integration|Context7|Task Agents', 'IgnoreCase')).Count
            outputDir = $variantDir
            promptPath = if ($meta) { $meta.promptPath } else { $PromptPath }
        }
        $summary.Add($row)

        if ($exitCode -eq 0) {
            Pass "Variant passed: system-isolated / $model / run $run"
        } else {
            Write-Host "[WARN] Variant failed: system-isolated / $model / run $run"
        }
    }
}

$summaryPath = Join-Path $OutputDir "ab-results.json"
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $summaryPath -Encoding utf8
Pass "Wrote A/B summary to $summaryPath"
