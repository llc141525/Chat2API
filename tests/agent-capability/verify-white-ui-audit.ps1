param(
    [Parameter(Mandatory=$true)]
    [string]$Model,

    [string]$LogPath = ".\dev.log",

    [int]$TimeoutSeconds = 240,

    [int]$ContextMaxMessages = 10,
    [int]$SummaryKeepRecentMessages = 5,

    [switch]$SkipProviderPreflight
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    Write-Host "WHITE_UI_AUDIT_PROBE_FAIL"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

# Backward-compat: re-use helper functions from the existing long-conversation probe script
# We dot-source them instead of duplicating.
$longProbeScript = Join-Path $PSScriptRoot "verify-opencode-long-conversation.ps1"
if (Test-Path $longProbeScript) {
    # We can't dot-source because the script has a param() block and exits.
    # Duplicate essential helpers inline.
}

function ConvertTo-StableJson($Value) {
    return $Value | ConvertTo-Json -Compress -Depth 20
}

function Get-ProviderNameFromModel([string]$ModelName) {
    $parts = $ModelName.Split("/", 2)
    if ($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { return "" }
    return $parts[0]
}

function Get-OpencodeConfigPath() {
    $candidates = @(
        (Join-Path $HOME ".config\opencode\opencode.json"),
        (Join-Path $HOME ".config\opencode\opencode.jsonc"),
        ".\opencode.json",
        ".\opencode.jsonc"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return (Resolve-Path $path).Path }
    }
    return ""
}

function Invoke-ProviderPreflight([string]$ModelName) {
    $providerName = Get-ProviderNameFromModel $ModelName
    if ([string]::IsNullOrWhiteSpace($providerName)) {
        Write-Host "[WARN] Skipping provider preflight because model has no provider prefix: $ModelName"
        return
    }
    $configPath = Get-OpencodeConfigPath
    if ([string]::IsNullOrWhiteSpace($configPath)) {
        Write-Host "[WARN] Skipping provider preflight because opencode config was not found"
        return
    }
    try {
        $config = Get-Content -Raw $configPath | ConvertFrom-Json
        $providerConfig = $config.provider.$providerName
        if ($null -eq $providerConfig) {
            Write-Host "[WARN] Skipping provider preflight because provider '$providerName' is not in $configPath"
            return
        }
        $baseUrl = [string]$providerConfig.options.baseURL
        $apiKey = [string]$providerConfig.options.apiKey
        if ([string]::IsNullOrWhiteSpace($baseUrl) -or [string]::IsNullOrWhiteSpace($apiKey)) {
            Write-Host "[WARN] Skipping provider preflight because provider '$providerName' has no baseURL/apiKey"
            return
        }
        $body = @{
            model = $ModelName; stream = $false
            messages = @(@{ role = "user"; content = "Reply exactly OK." })
        } | ConvertTo-Json -Depth 10
        $uri = $baseUrl.TrimEnd("/") + "/chat/completions"
        $response = Invoke-RestMethod -Method Post -Uri $uri -Headers @{
            Authorization = "Bearer $apiKey"; "Content-Type" = "application/json"
        } -Body $body -TimeoutSec 60
        $content = if ($response.choices -and $response.choices.Count -gt 0 -and $response.choices[0].message) {
            [string]$response.choices[0].message.content
        } else { ($response | ConvertTo-Json -Compress -Depth 20) }
        if ([string]::IsNullOrWhiteSpace($content)) {
            Fail "provider_preflight_failed: provider '$providerName' returned empty response"
        }
        Pass "Provider preflight succeeded for $ModelName via provider '$providerName'"
    } catch {
        Fail "provider_preflight_failed: $($_.Exception.Message)"
    }
}

function Resolve-OpencodeExecutablePath([string]$CandidatePath) {
    if (-not [string]::IsNullOrWhiteSpace($CandidatePath) -and (Test-Path $CandidatePath)) {
        $ext = [System.IO.Path]::GetExtension($CandidatePath)
        if ([string]::Equals($ext, ".exe", [StringComparison]::OrdinalIgnoreCase)) {
            return (Resolve-Path $CandidatePath).Path
        }
    }
    $common = @(
        (Join-Path $HOME "AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe"),
        (Join-Path $HOME "AppData\Roaming\npm\opencode.cmd")
    )
    foreach ($path in $common) { if (Test-Path $path) { return (Resolve-Path $path).Path } }
    return $CandidatePath
}

function ConvertTo-NativeProcessArgumentString([string[]]$Arguments) {
    $escaped = foreach ($arg in $Arguments) {
        if ($null -eq $arg -or $arg.Length -eq 0) { '""'; continue }
        if ($arg -notmatch '[\s"]') { $arg; continue }
        '"' + (($arg -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    }
    return $escaped -join ' '
}

function Invoke-OpencodeRun {
    param(
        [string]$Executable, [string]$Prompt, [string]$ModelName,
        [int]$TimeoutSeconds, [string]$SessionId = "", [string]$AgentName = ""
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Executable
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $args = @("run", "--model", $ModelName, "--format", "json", "--dir", ".", "--auto")
    if ($AgentName) { $args += @("--agent", $AgentName) }
    if ($SessionId) { $args += @("--session", $SessionId) }

    if ($null -ne $psi.ArgumentList) {
        foreach ($arg in $args) { $psi.ArgumentList.Add($arg) | Out-Null }
    } else {
        $psi.Arguments = ConvertTo-NativeProcessArgumentString $args
    }

    $p = [System.Diagnostics.Process]::new()
    $p.StartInfo = $psi
    $p.Start() | Out-Null
    $p.StandardInput.Write($Prompt)
    $p.StandardInput.Close()

    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $stderrTask = $p.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
        $timedOut = $true
        try { $p.Kill($true) } catch { try { $p.Kill() } catch {} }
        $p.WaitForExit() | Out-Null
    }
    return [ordered]@{
        TimedOut = $timedOut
        ExitCode = if ($timedOut) { $null } else { $p.ExitCode }
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

function Get-SessionIdFromEvents([string]$EventText) {
    foreach ($line in ($EventText -split "`r?`n")) {
        if ($line.Trim().Length -eq 0) { continue }
        try { $event = $line | ConvertFrom-Json } catch { continue }
        $sid = [string]$event.sessionID
        if ($sid) { return $sid }
    }
    return ""
}

function Get-NewLogText([string]$Path, [int]$BeforeLineCount) {
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $lines = @(Get-Content $Path)
        if ($lines.Count -gt $BeforeLineCount) {
            return ($lines | Select-Object -Skip $BeforeLineCount) -join [Environment]::NewLine
        }
        Start-Sleep -Seconds 1
    }
    return ""
}

function Test-HasSummaryCompactionEvidence([string]$LogText) {
    return $LogText -match '"strategyName":"summary".*"trimmed":true'
}

function Read-ContextManagementState([string]$StoreDir) {
    $oldDir = $env:CHAT2API_STORE_DIR
    try {
        $env:CHAT2API_STORE_DIR = $StoreDir
        $json = node --input-type=module -e @'
import Store from 'electron-store'
const store = new Store({ name: 'data', cwd: process.env.CHAT2API_STORE_DIR, encryptionKey: 'chat2api-fixed-encryption-key-v1' })
const config = store.get('config') || {}
const has = Object.prototype.hasOwnProperty.call(config, 'contextManagement')
console.log(JSON.stringify({ hasContextManagement: has, value: has ? config.contextManagement : null }))
'@
        return $json | ConvertFrom-Json
    } finally { $env:CHAT2API_STORE_DIR = $oldDir }
}

function Write-ContextManagementState([string]$StoreDir, $State) {
    $oldDir = $env:CHAT2API_STORE_DIR
    $oldJson = $env:CHAT2API_CONTEXT_STATE_JSON
    try {
        $env:CHAT2API_STORE_DIR = $StoreDir
        $env:CHAT2API_CONTEXT_STATE_JSON = $State | ConvertTo-Json -Compress -Depth 100
        node --input-type=module -e @'
import Store from 'electron-store'
const state = JSON.parse(process.env.CHAT2API_CONTEXT_STATE_JSON)
const store = new Store({ name: 'data', cwd: process.env.CHAT2API_STORE_DIR, encryptionKey: 'chat2api-fixed-encryption-key-v1' })
const config = store.get('config') || {}
if (state.hasContextManagement) { config.contextManagement = state.value } else { delete config.contextManagement }
store.set('config', config)
'@
    } finally {
        $env:CHAT2API_STORE_DIR = $oldDir
        $env:CHAT2API_CONTEXT_STATE_JSON = $oldJson
    }
}

# ─── Probe entry point ─────────────────────────────────────────────

$probeDir = Join-Path (Resolve-Path ".") ".agent-probe"
if (Test-Path $probeDir) { Remove-Item -Recurse -Force $probeDir }
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null

$notesPath    = "$probeDir/white-ui-notes.txt"
$decisionPath = "$probeDir/white-ui-decision.txt"
$auditPath    = "$probeDir/white-ui-audit.md"
$eventsPath   = "$probeDir/white-ui-events.ndjson"
$storeDir     = Join-Path $HOME ".chat2api"

Write-Host "============================================"
Write-Host " Chat2API White-UI Audit Probe"
Write-Host " Model: $Model"
Write-Host " Context: maxMessages=$ContextMaxMessages keepRecent=$SummaryKeepRecentMessages"
Write-Host "============================================"

if (-not $SkipProviderPreflight) { Invoke-ProviderPreflight $Model }
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { Fail "opencode not found" }

$originalContextState = Read-ContextManagementState $storeDir
$aggressive = [ordered]@{
    hasContextManagement = $true
    value = [ordered]@{
        enabled = $true
        strategies = [ordered]@{
            slidingWindow = [ordered]@{ enabled = $true; maxMessages = $ContextMaxMessages }
            tokenLimit = [ordered]@{ enabled = $false; maxTokens = 4000 }
            summary = [ordered]@{
                enabled = $true
                keepRecentMessages = $SummaryKeepRecentMessages
                summaryPrompt = "Summarize the earlier conversation as procedural state for an in-progress UI audit. Preserve exact file paths already read, color tokens found, and remaining required steps."
            }
        }
        executionOrder = @("summary", "slidingWindow")
    }
}

$beforeLogLines = @(Get-Content $LogPath)
$prompt = Get-Content -Raw "tests/agent-capability/white-ui-audit-prompt.md"

try {
    Write-ContextManagementState $storeDir $aggressive
    Pass "Temporarily enabled aggressive context management"

    $opencodeCmd = Get-Command opencode -ErrorAction SilentlyContinue
    $exe = Resolve-OpencodeExecutablePath $opencodeCmd.Source

    # ─── Phase: Warmup turns to trigger compaction ────────
    Write-Host "Running warmup turns..."
    $sessionId = ""
    for ($turn = 1; $turn -le 7; $turn++) {
        $wp = "Warmup turn $turn. Reply exactly WARMUP_OK_$turn. Do not use tools."
        $r = Invoke-OpencodeRun -Executable $exe -Prompt $wp -ModelName $Model -TimeoutSeconds $TimeoutSeconds -SessionId $sessionId
        [System.IO.File]::AppendAllText($eventsPath, [string]$r.Stdout + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        if ($r.TimedOut) { Fail "warmup timeout turn $turn" }
        if ($r.ExitCode -ne 0) { Fail "warmup exit $($r.ExitCode) turn $turn" }
        if (-not $sessionId) { $sessionId = Get-SessionIdFromEvents ([string]$r.Stdout) }
    }
    Pass "Completed 7 warmup turns in session $sessionId"

    $postWarmupLog = Get-NewLogText $LogPath $beforeLogLines.Count
    if (-not (Test-HasSummaryCompactionEvidence $postWarmupLog)) {
        Fail "No compaction evidence after warmup"
    }
    Pass "Compaction confirmed in dev.log"

    # ─── Phase: Run the white-UI audit probe ─────────────
    Write-Host "Running white-UI audit probe..."
    $runResult = Invoke-OpencodeRun -Executable $exe -Prompt $prompt -ModelName $Model -TimeoutSeconds $TimeoutSeconds -SessionId $sessionId -AgentName "white-ui-audit-probe"
    [System.IO.File]::AppendAllText($eventsPath, [string]$runResult.Stdout + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    if ($runResult.TimedOut) { Fail "probe timeout" }
    if ($runResult.ExitCode -ne 0) { Fail "probe exit code $($runResult.ExitCode)" }
    Pass "OpenCode exited successfully"

    # Verify Phase 1 artifacts
    if (-not (Test-Path $notesPath)) { Fail "Missing $notesPath (Phase 1 discovery)" }
    $notesContent = Get-Content -Raw $notesPath
    if ($notesContent.Length -lt 100) { Fail "white-ui-notes.txt too short ($($notesContent.Length) chars)" }
    Pass "Phase 1: Discovery notes written ($($notesContent.Length) chars)"

    # Verify Phase 3 artifacts
    if (-not (Test-Path $decisionPath)) { Fail "Missing $decisionPath (Phase 3 discussion)" }
    $decisionContent = Get-Content -Raw $decisionPath
    if ($decisionContent -notmatch 'recommend|consistent|inconsistent|specific') {
        Fail "white-ui-decision.txt lacks analysis content"
    }
    Pass "Phase 3: Decision summary written"

    # Verify Phase 4: final spec
    if (-not (Test-Path $auditPath)) { Fail "Missing $auditPath (Phase 4 final spec)" }
    $auditContent = Get-Content -Raw $auditPath
    if ($auditContent -notmatch 'WHITE_UI_AUDIT_DONE') {
        Fail "Final audit missing WHITE_UI_AUDIT_DONE marker"
    }

    # Quality checks
    $hasTokenInventory = $auditContent -match 'color|token|white|light|bg|background|--'
    $hasFilePath = $auditContent -match 'E:\\Chat2API\\|src\\|\.tsx|\.css|tailwind'
    $hasRecommendation = $auditContent -match 'recommend|suggest|improve|fix|should'

    if (-not $hasTokenInventory) { Fail "Audit lacks color token inventory" }
    if (-not $hasFilePath) { Fail "Audit lacks concrete file paths" }
    if (-not $hasRecommendation) { Fail "Audit lacks recommendations" }
    Pass "Phase 4: Final audit spec is structurally valid with specific content"

    Write-Host "WHITE_UI_AUDIT_PROBE_PASS"
    exit 0
}
finally {
    try {
        Write-ContextManagementState $storeDir $originalContextState
        Write-Host "[PASS] Restored original context management config"
    } catch {
        Write-Host "[WARN] Failed to restore config: $_"
    }
}
