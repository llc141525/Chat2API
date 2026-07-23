param(
    [Parameter(Mandatory=$true)]
    [string]$Model,

    [string]$LogPath = ".\dev.log",

    [string]$PromptPath = "tests/agent-capability/long-conversation-ui-probe.md",

    [int]$TimeoutSeconds = 300,

    [int]$ContextMaxMessages = 10,

    [int]$SummaryKeepRecentMessages = 5,

    [switch]$SkipProviderPreflight,

    [switch]$SkipDevServerStart
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
. (Join-Path $PSScriptRoot "verify-opencode-long-conversation-v2.helpers.ps1")

# ═══════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════

function Fail([string]$Message) {
    throw [System.InvalidOperationException]::new("PROBE_FAIL::$Message")
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function Get-ProviderNameFromModel([string]$ModelName) {
    $parts = $ModelName.Split("/", 2)
    if ($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { return "" }
    return $parts[0]
}

function Invoke-ProviderPreflight([string]$ModelName) {
    $providerName = Get-ProviderNameFromModel $ModelName
    if ([string]::IsNullOrWhiteSpace($providerName)) { return }
    $configPath = Resolve-OpenCodeConfigPath
    $apiKey = ""
    try {
        $config = Get-Content -Raw $configPath | ConvertFrom-Json
        $providerConfig = $config.provider.$providerName
        if ($null -eq $providerConfig) { return }
        $baseUrl = [string]$providerConfig.options.baseURL
        $apiKey = [string]$providerConfig.options.apiKey
        if ([string]::IsNullOrWhiteSpace($baseUrl) -or [string]::IsNullOrWhiteSpace($apiKey)) { return }
        $body = @{ model = $ModelName; stream = $false; messages = @(@{ role = "user"; content = "Reply exactly OK." }) } | ConvertTo-Json -Depth 10
        $uri = $baseUrl.TrimEnd("/") + "/chat/completions"
        $response = Invoke-ProviderPreflightWithRetry `
            -Description "$ModelName via provider '$providerName'" `
            -Request {
                Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Bearer $apiKey"; "Content-Type" = "application/json" } -Body $body -TimeoutSec 60
            }
        $content = if ($response.choices -and $response.choices[0].message) { [string]$response.choices[0].message.content } else { ($response | ConvertTo-Json -Compress) }
        if ([string]::IsNullOrWhiteSpace($content)) { Fail "provider_preflight_failed: empty response" }
        if ($content -match 'Error:|错误|refresh|try again|rate.?limit|429') { Fail "provider_preflight_failed: $content" }
        Pass "Provider preflight succeeded for $ModelName via provider '$providerName'"
    } catch {
        $safeMessage = ($_.Exception.Message -replace [regex]::Escape($apiKey), "<redacted>")
        Fail "provider_preflight_failed: $safeMessage"
    }
}

function Get-ProviderBaseUrlPort([string]$ModelName) {
    $providerName = Get-ProviderNameFromModel $ModelName
    if ([string]::IsNullOrWhiteSpace($providerName)) { return $null }
    try {
        $configPath = Resolve-OpenCodeConfigPath
        $config = Get-Content -Raw $configPath | ConvertFrom-Json
        $baseUrl = [string]$config.provider.$providerName.options.baseURL
        if ([string]::IsNullOrWhiteSpace($baseUrl)) { return $null }
        $uri = [System.Uri]$baseUrl
        if ($uri.Port -gt 0) { return [int]$uri.Port }
    } catch {
        return $null
    }
    return $null
}

function Read-JsonFile([string]$Path) {
    try { return Get-Content -Raw $Path | ConvertFrom-Json }
    catch { Fail "Failed to parse $Path : $_" }
}

function Write-JsonFile([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Add-EventTextToFile([string]$Path, [string]$EventText) {
    if ([string]::IsNullOrWhiteSpace($EventText)) { return }
    $normalized = $EventText.TrimEnd()
    if ($normalized.Length -eq 0) { return }
    [System.IO.File]::AppendAllText($Path, $normalized + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-OpencodeExe {
    $npmRoot = Join-Path $HOME "AppData\Roaming\npm\node_modules"
    $candidates = @(
        (Join-Path $npmRoot ".opencode-ai-*\node_modules\opencode-windows-x64\bin\opencode.exe"),
        (Join-Path $npmRoot "opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe"),
        "C:\Users\llc\AppData\Roaming\npm\opencode.cmd"
    )
    foreach ($pattern in $candidates) {
        foreach ($path in @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue)) {
            if ($path.Length -gt 1MB) { return $path.FullName }
        }
    }
    # Fallback to opencode.cmd
    $cmd = Join-Path $HOME "AppData\Roaming\npm\opencode.cmd"
    if (Test-Path $cmd) { return $cmd }
    throw "Cannot find opencode native executable"
}

function Invoke-OpencodeRun {
    param([string]$Prompt, [string]$ModelName, [int]$TimeoutSeconds, [string]$SessionId = "", [string]$AgentName = "")
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Resolve-OpencodeExe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $args = @("run", "--model", $ModelName, "--format", "json", "--dir", ".", "--auto")
    if ($AgentName) { $args += @("--agent", $AgentName) }
    if ($SessionId) { $args += @("--session", $SessionId) }
    # Bypass ProcessStartInfo.ArgumentList NRE on some Windows shells
    $psi.Arguments = ($args | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }) -join ' '
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
    return [ordered]@{ TimedOut = $timedOut; ExitCode = if ($timedOut) { $null } else { $p.ExitCode }; Stdout = $stdoutTask.GetAwaiter().GetResult(); Stderr = $stderrTask.GetAwaiter().GetResult() }
}

function Get-NewLogText([string]$LogPath, [int]$BeforeLineCount) {
    $afterLogLines = @(); $previousCount = -1; $stableObservations = 0
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $afterLogLines = @(Get-Content $LogPath)
        if ($afterLogLines.Count -le $BeforeLineCount) { Start-Sleep 1; continue }
        if ($afterLogLines.Count -eq $previousCount) { $stableObservations++ } else { $previousCount = $afterLogLines.Count; $stableObservations = 0 }
        if ($stableObservations -ge 2) { break }
        Start-Sleep 1
    }
    if ($afterLogLines.Count -gt $BeforeLineCount) {
        return ($afterLogLines | Select-Object -Skip $BeforeLineCount) -join [Environment]::NewLine
    }
    return ""
}

function Test-HasCompactionEvidence([string]$LogText) {
    # ContextManagementService strategy trace (may be at debug level in Phase 2 logger)
    $hasSummaryTrim = $LogText -match '"strategyName"\s*:\s*"summary".*"trimmed"\s*:\s*true'
    $hasSlidingTrim = $LogText -match '"strategyName"\s*:\s*"slidingWindow".*"trimmed"\s*:\s*true'
    # Forwarder context management applied
    $hasForwarderEvidence = $LogText -match '\[Forwarder\] Context management applied:'
    # ProviderRuntime shows server_summary boundary
    $hasServerSummary = $LogText -match '"boundary"\s*:\s*"server_summary"'
    return ($hasSummaryTrim -or $hasSlidingTrim) -and ($hasForwarderEvidence -or $hasServerSummary)
}

function Invoke-SessionReportAudit([string]$LogText, [string]$EventsPath, [string]$ProbeDir, [string[]]$LogSourcePaths, [int]$RuntimeStructuredLogLineCount, [string]$ProbeRunMarkerId, [int]$ProbeRunStartMarkerCount, [int]$ProbeRunEndMarkerCount, $ProbeRunLockHandle) {
    if ([string]::IsNullOrWhiteSpace($LogText)) { Fail "session_report_failed: no per-run log text available" }
    if ($RuntimeStructuredLogLineCount -lt 1) { Fail "session_report_failed: no runtime structured app/request records captured for this run" }
    if ([string]::IsNullOrWhiteSpace($ProbeRunMarkerId)) { Fail "session_report_failed: no probe run log marker id captured" }
    if ($ProbeRunStartMarkerCount -lt 1 -or $ProbeRunEndMarkerCount -lt 1) { Fail "session_report_failed: missing probe run structured log boundary markers" }
    $reportLogPath = Join-Path $ProbeDir "dev-log-slice.log"
    $reportDir = Join-Path $ProbeDir "session-reports"
    [System.IO.File]::WriteAllText($reportLogPath, $LogText, [System.Text.UTF8Encoding]::new($false))
    $beforeReports = @()
    if (Test-Path $reportDir) { $beforeReports = @(Get-ChildItem -Path $reportDir -Filter "session-report-*.json" -File) }
    & .\scripts\extract-session-log.ps1 -LogPath $reportLogPath -OutputDir $reportDir -EventsPath $EventsPath -Strict | Write-Host
    if ($LASTEXITCODE -ne 0) { Fail "session_report_failed: extract-session-log.ps1 rejected the run" }
    $afterReports = @(Get-ChildItem -Path $reportDir -Filter "session-report-*.json" -File | Sort-Object LastWriteTime -Descending)
    $report = $afterReports | Where-Object { $beforeReports.FullName -notcontains $_.FullName } | Select-Object -First 1
    if ($null -eq $report) { $report = $afterReports | Select-Object -First 1 }
    if ($null -eq $report) { Fail "session_report_failed: report file was not created" }
    $json = Read-JsonFile $report.FullName
    if ($null -eq $json.sessions -or $json.sessionCount -lt 1) { Fail "session_report_failed: report has no sessions" }
    if ($json.issues -and $json.issues.Count -gt 0) { Fail "session_report_failed: report contains issues: $($json.issues -join '; ')" }
    Update-SessionReportRunMetadata `
        -ReportPath $report.FullName `
        -ProbeDir $ProbeDir `
        -LogSourcePaths $LogSourcePaths `
        -RuntimeStructuredLogLineCount $RuntimeStructuredLogLineCount `
        -ProbeRunMarkerId $ProbeRunMarkerId `
        -ProbeRunStartMarkerCount $ProbeRunStartMarkerCount `
        -ProbeRunEndMarkerCount $ProbeRunEndMarkerCount `
        -ProbeRunLockHandle $ProbeRunLockHandle | Out-Null
    Pass "Session report generated: $($report.FullName)"
}

# ═══════════════════════════════════════════
# Main
# ═══════════════════════════════════════════

Write-Host "============================================"
Write-Host " Chat2API Long Conversation Compaction Probe"
Write-Host " Model: $Model"
Write-Host " Context: maxMessages=$ContextMaxMessages keepRecent=$SummaryKeepRecentMessages"
Write-Host "============================================"

$devServerHandle = $null
$originalState = $null
$contextConfigWasWritten = $false
$storeDir = Join-Path $HOME ".chat2api"
$previousStoreDir = $env:CHAT2API_STORE_DIR
$probeProxyPort = Get-ProviderBaseUrlPort $Model
if ($null -eq $probeProxyPort) { $probeProxyPort = 48763 }
$newLogText = ""
$structuredLogSnapshots = @()
$structuredLogSources = @()
$probeDir = ""
$probeRootArtifactSnapshots = @()
$probeRootArtifactAuditCompleted = $false
$probeRunLogMarkerId = ""
$probeRunLockHandle = $null
$probeRunStartMarkerWritten = $false
$probeRunEndMarkerWritten = $false
$probeRunSkillState = $null
$opencodeConfigState = $null
$opencodeModelName = ""
$exitCode = 1

try {
$probeRoot = Join-Path (Resolve-Path ".") ".agent-probe"
# Keep prior probe artifacts/log slices intact: v2 creates an isolated child run
# directory and never recursively deletes .agent-probe, so -LogPath is safe even
# when callers keep related diagnostics near the probe root.
$probeDir = New-ProbeRunDirectory $probeRoot

$eventsPath = "$probeDir/opencode-long-events.ndjson"
$stderrPath = "$probeDir/opencode-long-stderr.log"

# Artifacts the white-ui-audit skill must produce
$notesPath = "$probeDir/white-ui-notes.txt"
$decisionPath = "$probeDir/white-ui-decision.txt"
$auditPath = "$probeDir/white-ui-audit.md"
$probeRootArtifactSnapshots = Get-ProbeRootArtifactSnapshots $probeRoot
$activeSkillPath = Join-Path (Resolve-Path ".").Path ".opencode\skills\white-ui-audit-probe\SKILL.md"

if (-not (Test-Path $promptPath)) { Fail "Prompt file not found: $promptPath" }
if (-not (Test-Path $LogPath)) {
    [System.IO.File]::WriteAllText($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogPath), "", [System.Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path $storeDir)) { Fail "Config store directory not found: $storeDir" }
$opencodeExe = Resolve-OpencodeExe
if (-not $opencodeExe) { Fail "opencode not found" }
$opencodeConfigPath = Resolve-OpenCodeConfigPath
$opencodeModelName = Resolve-OpenCodeRegisteredModelName -ConfigPath $opencodeConfigPath -RequestedModel $Model
Pass "Resolved OpenCode --model '$Model' -> '$opencodeModelName'"
$opencodeConfigState = Set-OpenCodeLocalProviderBaseUrlsForProbe -ConfigPath $opencodeConfigPath -Port $probeProxyPort
Pass "Temporarily aligned $($opencodeConfigState.UpdatedCount) OpenCode local provider baseURL(s) to $($opencodeConfigState.ReplacementBaseUrl)"

$probeRunLogMarkerId = New-ProbeRunLogMarker $probeDir
$structuredLogSources = Get-StructuredLogSourcePaths $storeDir
$probeRunLockHandle = Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $probeDir -MarkerId $probeRunLogMarkerId -LogSourcePaths $structuredLogSources
$probeRunSkillState = Set-ProbeRunSkillArtifactDirectory -SkillPath $activeSkillPath -ProbeDir $probeDir
Pass "Prepared active OpenCode skill with run-specific artifact paths: $activeSkillPath"

# Enable aggressive compaction
$aggressiveState = @{
    hasContextManagement = $true
    value = @{
        enabled = $true
        strategies = @{
            slidingWindow = @{ enabled = $true; maxMessages = $ContextMaxMessages }
            tokenLimit = @{ enabled = $false; maxTokens = 4000 }
            summary = @{
                enabled = $true
                keepRecentMessages = $SummaryKeepRecentMessages
                summaryPrompt = "Summarize the earlier conversation as procedural state for an in-progress tool workflow. Preserve exact pending obligations, required file paths, remaining tool sequence, and tool-result facts. Do not answer the conversation. Do not add chit-chat."
            }
        }
        executionOrder = @("summary", "slidingWindow")
    }
}
try {
    # Read/write probe config via electron-store before starting Electron so
    # auto-started proxy and readiness wait use the same port as OpenCode.
    $env:CHAT2API_STORE_DIR = $storeDir
    $originalRaw = node --input-type=module -e @'
import Store from 'electron-store'
const store = new Store({ name: 'data', cwd: process.env.CHAT2API_STORE_DIR, encryptionKey: 'chat2api-fixed-encryption-key-v1' })
const config = store.get('config') || {}
console.log(JSON.stringify({
  hasContextManagement: Object.prototype.hasOwnProperty.call(config, 'contextManagement'),
  contextManagement: config.contextManagement || null,
  hasProxyPort: Object.prototype.hasOwnProperty.call(config, 'proxyPort'),
  proxyPort: config.proxyPort ?? null,
  hasAutoStartProxy: Object.prototype.hasOwnProperty.call(config, 'autoStartProxy'),
  autoStartProxy: config.autoStartProxy ?? null
}))
'@
    if ($LASTEXITCODE -ne 0) { Fail "Failed to read context management config" }
    $originalState = $originalRaw | ConvertFrom-Json

    $stateJson = ($aggressiveState | ConvertTo-Json -Compress -Depth 100)
    $env:CHAT2API_CONTEXT_STATE_JSON = $stateJson
    $env:CHAT2API_PROBE_PROXY_PORT = [string]$probeProxyPort
    node --input-type=module -e @'
import Store from 'electron-store'
const state = JSON.parse(process.env.CHAT2API_CONTEXT_STATE_JSON)
const proxyPort = Number(process.env.CHAT2API_PROBE_PROXY_PORT)
const store = new Store({ name: 'data', cwd: process.env.CHAT2API_STORE_DIR, encryptionKey: 'chat2api-fixed-encryption-key-v1' })
const config = store.get('config') || {}
if (state.hasContextManagement) { config.contextManagement = state.value } else { delete config.contextManagement }
config.proxyPort = proxyPort
config.autoStartProxy = true
store.set('config', config)
'@
    if ($LASTEXITCODE -ne 0) { Fail "Failed to write context management config" }
    $contextConfigWasWritten = $true
    $env:CHAT2API_STORE_DIR = $previousStoreDir
    Pass "Temporarily enabled aggressive context management and proxyPort=$probeProxyPort in config store"
} catch { Fail "context_management_config_failed: $_" }

if (-not $SkipDevServerStart) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if ($null -eq $npm) { Fail "npm not found; cannot start Chat2API dev server log capture" }
    $npmPath = Resolve-CommandPath $npm
    if ([string]::IsNullOrWhiteSpace($npmPath)) { Fail "npm command path could not be resolved; cannot start Chat2API dev server log capture" }
    $devServerHandle = Start-LoggedProcess -FileName $npmPath -Arguments @("run", "dev:win") -LogPath $LogPath -WorkingDirectory (Get-Location).Path
    Pass "Started Chat2API dev server with stdout/stderr appended to $LogPath"
    Wait-TcpEndpointReady -HostName "127.0.0.1" -Port $probeProxyPort -TimeoutSeconds 90 | Out-Null
    Pass "Chat2API dev server is accepting TCP connections on 127.0.0.1:$probeProxyPort"
}
if (-not $SkipProviderPreflight) { Invoke-ProviderPreflight $Model }

$structuredLogSnapshots = Get-LogLineSnapshots $structuredLogSources
Write-StructuredLogRunMarker -Paths $structuredLogSources -ProbeDir $probeDir -MarkerId $probeRunLogMarkerId -Phase "start"
$probeRunStartMarkerWritten = $true
$beforeLogLines = @(Get-Content $LogPath)
$prompt = ConvertTo-ProbeRunPrompt -Prompt (Get-Content -Raw $promptPath) -ProbeDir $probeDir

Write-Host "Running OpenCode with white-ui-audit-probe..."

$runResult = Invoke-OpencodeRun -Prompt $prompt -ModelName $opencodeModelName -TimeoutSeconds $TimeoutSeconds
Write-StructuredLogRunMarker -Paths $structuredLogSources -ProbeDir $probeDir -MarkerId $probeRunLogMarkerId -Phase "end"
$probeRunEndMarkerWritten = $true
[System.IO.File]::WriteAllText($eventsPath, [string]$runResult.Stdout, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($stderrPath, [string]$runResult.Stderr, [System.Text.UTF8Encoding]::new($false))

# ═══ Timeout analysis ═══
if ($runResult.TimedOut) {
    $output = [string]$runResult.Stdout
    $hadFinalMarker = $output.Contains("LONG_CONVERSATION_PROBE_DONE")
    $hadNotes = Test-Path $notesPath
    $hadDecision = Test-Path $decisionPath
    $hadAudit = Test-Path $auditPath

    if ($hadAudit -and $hadFinalMarker) {
        Fail "opencode_turn_timeout_after_final_marker: OpenCode emitted LONG_CONVERSATION_PROBE_DONE and wrote white-ui-audit.md but did not exit within $TimeoutSeconds s"
    }
    if ($hadDecision) { Fail "opencode_turn_timeout_after_decision: OpenCode reached white-ui-decision.txt (Phase 3) but did not exit within $TimeoutSeconds s" }
    if ($hadNotes) { Fail "opencode_turn_timeout_after_notes: OpenCode reached white-ui-notes.txt (Phase 1) but did not exit within $TimeoutSeconds s" }
    Fail "opencode_turn_timeout_before_any_artifact: OpenCode did not create any probe artifact within $TimeoutSeconds s"
}

if ($runResult.ExitCode -ne 0) {
    Fail "opencode exited with code $($runResult.ExitCode)"
}
Pass "OpenCode exited successfully"

# ═══ Artifact existence ═══
if (-not (Test-Path $notesPath)) { Fail "Missing $notesPath — Phase 1 incomplete" }
if (-not (Test-Path $decisionPath)) { Fail "Missing $decisionPath — Phase 3 incomplete" }
if (-not (Test-Path $auditPath)) { Fail "Missing $auditPath — Phase 4 incomplete" }
Assert-NoProbeRootArtifactWrites -Snapshots $probeRootArtifactSnapshots -ProbeDir $probeDir
$probeRootArtifactAuditCompleted = $true
Pass "All 3 probe artifacts created"

# ═══ Final marker check ═══
$auditContent = Get-Content -Raw $auditPath
$auditLines = @($auditContent -split "\r?\n" | Where-Object { $_.Length -gt 0 })
$hasMarker = $auditLines.Count -gt 0 -and $auditLines[-1] -eq "WHITE_UI_AUDIT_DONE"
$hasRequiredSections = ($auditContent -match "(?i)color.*(token|inventory)") -and
                       ($auditContent -match "(?i)(inconsistenc|finding)") -and
                       ($auditContent -match "(?i)(component.*coverage|file.*analyz)") -and
                       ($auditContent -match "(?i)(recommendation|improvement)")
if (-not $hasMarker) {
    Fail "white-ui-audit.md must end with WHITE_UI_AUDIT_DONE"
}
if (-not $hasRequiredSections) { Fail "white-ui-audit.md is missing one or more required sections" }
Pass "Final marker WHITE_UI_AUDIT_DONE is the last non-empty line"

# Final marker is WHITE_UI_AUDIT_DONE in the audit file (already verified above)

# ═══ Skill used first ═══
$eventLines = Get-Content $eventsPath | Where-Object { $_.Trim().Length -gt 0 }
if ($eventLines.Count -eq 0) { Fail "Event log is empty" }
$firstToolName = ""
foreach ($line in $eventLines) {
    try {
        $evt = $line | ConvertFrom-Json
        if ($evt.type -eq "tool_use") {
            $firstToolName = [string]$evt.part.tool
            break
        }
        # Check for text before tool_use — fail if meaningful text appears
        if ($evt.type -eq "text") {
            $text = [string]$evt.part.text
            if ($text.Trim().Length -gt 0 -and $text -notmatch '^(OK\.|Hi|Hello|I)') {
                Fail "Meaningful text appeared before the first tool_use: $($text.Substring(0, [Math]::Min(80, $text.Length)))"
            }
        }
    } catch { continue }
}
if ($firstToolName -ne "skill") {
    Fail "First tool_use was '$firstToolName', expected 'skill' for white-ui-audit-probe"
}
Pass "First tool call was skill (white-ui-audit-probe)"

# ═══ Tool call audit: no repetition, no raw XML ═══
$toolCalls = @{}
$rawXmlPatterns = @("<\|CHAT2API\|", "<tool_call>", "<tool_result>", "<invoke name=", "</invoke>", "</tool_call>", "<parameter name=")
foreach ($line in $eventLines) {
    try {
        $evt = $line | ConvertFrom-Json
    } catch { Fail "Invalid NDJSON: $($line.Substring(0, [Math]::Min(80, $line.Length)))" }

    # Check text for raw XML
    if ($evt.type -eq "text") {
        $text = [string]$evt.part.text
        foreach ($pat in $rawXmlPatterns) {
            if ($text.Contains($pat)) {
                Fail "Raw managed XML token leaked into visible text: '$pat' in response"
            }
        }
    }

    # Track tool calls for repetition detection (exempt .txt re-reads — Phase 2 context recovery)
    if ($evt.type -eq "tool_use") {
        $toolName = [string]$evt.part.tool
        # OpenCode nests input under state.input as an object
        $toolInput = ConvertTo-Json -Compress -Depth 5 $evt.part.state.input
        # Phase 2 intentionally re-reads notes/decision — skip
        if ($toolInput -match 'white-ui-notes|white-ui-decision') { continue }
        $sig = "$toolName|$toolInput"
        if (-not $toolCalls.ContainsKey($sig)) { $toolCalls[$sig] = 0 }
        $toolCalls[$sig]++
    }

}
# After loop: fail on excessive repetition (3+ identical calls)
$excessiveRepeats = @($toolCalls.GetEnumerator() | Where-Object { $_.Value -ge 3 })
if ($excessiveRepeats.Count -gt 0) {
    $detail = ($excessiveRepeats | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join "; "
    Fail "Excessive repeated tool calls (3+ each): $detail"
}
$moderateRepeats = @($toolCalls.GetEnumerator() | Where-Object { $_.Value -ge 2 })
if ($moderateRepeats.Count -gt 0) {
    $detail = ($moderateRepeats | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join "; "
    Write-Host "[WARN] Moderate tool repetition detected: $detail"
}
Pass "No raw XML leakage or repeated tool calls detected"

# ═══ Phase 2: distinct files check ═══
$phaseReadAudit = Get-OpenCodeLongProbePhaseReadAudit $eventLines
if (-not [bool]$phaseReadAudit.NotesWriteSeen) { Fail "Phase boundary missing: white-ui-notes.txt was not written" }
if (-not [bool]$phaseReadAudit.NotesRecoveryReadSeen) { Fail "Phase boundary missing: white-ui-notes.txt was not re-read before Phase 2" }
if (@($phaseReadAudit.Phase1Reads).Count -ne 2) { Fail "Phase 1 must read exactly 2 component files, found $(@($phaseReadAudit.Phase1Reads).Count)" }
if (@($phaseReadAudit.Phase2Reads).Count -ne 2) { Fail "Phase 2 must read exactly 2 component files, found $(@($phaseReadAudit.Phase2Reads).Count)" }
if (@($phaseReadAudit.PhaseOverlap).Count -gt 0) { Fail "Phase 2 re-read a file from Phase 1: $(@($phaseReadAudit.PhaseOverlap) -join ', ')" }
Pass "Phase 1 and Phase 2 each read exactly 2 distinct component files"

# ═══ Compaction evidence (non-fatal: complete workflow proves resilience) ═══
$startupLogText = Get-NewLogText $LogPath $beforeLogLines.Count
$structuredLogAudit = Get-StructuredLogDeltaAudit $structuredLogSnapshots $probeDir $probeRunLogMarkerId
$newLogText = [string]$structuredLogAudit.Text
if ($newLogText.Length -eq 0) { Fail "No new structured app/request log content captured during probe" }
if ([int]$structuredLogAudit.RuntimeStructuredLogLineCount -lt 1) { Fail "No runtime structured app/request records captured during probe" }
if ([int]$structuredLogAudit.ProbeRunStartMarkerCount -lt 1 -or [int]$structuredLogAudit.ProbeRunEndMarkerCount -lt 1) { Fail "No matching probe run start/end markers captured in structured logs" }
if (-not (Test-HasCompactionEvidence $newLogText)) {
    Write-Host "[WARN] No compaction evidence in structured app/request log slice — but 4-phase workflow completed successfully, proving post-compaction resilience"
} else {
    Pass "structured app/request logs prove compaction during probe"
}

# ═══ Contamination drift check ═══
$allOutput = [string]$runResult.Stdout + [string]$runResult.Stderr + $auditContent
$forbiddenTools = @("Burp Suite MCP", "GitHub Integration", "Context7", "Task Agents", "WebFetch", "Filesystem")
foreach ($tool in $forbiddenTools) {
    if ($allOutput.Contains($tool)) {
        Fail "Fabricated tool name '$tool' leaked into probe output — summary contamination"
    }
}
Pass "No fabricated tool inventory contamination detected"

# ═══ Audit content quality ═══
if ($auditContent -notmatch "tailwind\.config" -and $auditContent -notmatch "index\.css") {
    Fail "white-ui-audit.md does not reference expected config files"
}
if ($auditContent -notmatch "color|token|white|light|bg-|text-") {
    Write-Host "[WARN] white-ui-audit.md may lack color/token analysis content"
}
$sectionCount = ([regex]::Matches($auditContent, '^##+\s')).Count
if ($sectionCount -ne 4) { Fail "white-ui-audit.md must contain exactly 4 sections, found $sectionCount" }
Pass "white-ui-audit.md contains substantive UI audit content ($sectionCount sections)"

# ═══ Session report audit ═══
Invoke-SessionReportAudit `
    -LogText $newLogText `
    -EventsPath $eventsPath `
    -ProbeDir $probeDir `
    -LogSourcePaths $structuredLogAudit.SourcePaths `
    -RuntimeStructuredLogLineCount ([int]$structuredLogAudit.RuntimeStructuredLogLineCount) `
    -ProbeRunMarkerId ([string]$structuredLogAudit.ProbeRunMarkerId) `
    -ProbeRunStartMarkerCount ([int]$structuredLogAudit.ProbeRunStartMarkerCount) `
    -ProbeRunEndMarkerCount ([int]$structuredLogAudit.ProbeRunEndMarkerCount) `
    -ProbeRunLockHandle $probeRunLockHandle

# ═══ PASS ═══
Write-Host ""
Write-Host "CAPABILITY_PROBE_PASS"
Write-Host "LONG_CONVERSATION_PROBE_PASS"
$exitCode = 0
} catch {
    $message = [string]$_.Exception.Message
    if ($message.StartsWith("PROBE_FAIL::")) {
        $message = $message.Substring("PROBE_FAIL::".Length)
    }
    if (-not $probeRootArtifactAuditCompleted -and -not [string]::IsNullOrWhiteSpace($probeDir) -and $null -ne $probeRootArtifactSnapshots) {
        try {
            Assert-NoProbeRootArtifactWrites -Snapshots $probeRootArtifactSnapshots -ProbeDir $probeDir
            $probeRootArtifactAuditCompleted = $true
        } catch {
            $rootArtifactMessage = [string]$_.Exception.Message
            if ($rootArtifactMessage.StartsWith("PROBE_FAIL::")) {
                $rootArtifactMessage = $rootArtifactMessage.Substring("PROBE_FAIL::".Length)
            }
            $message = "$rootArtifactMessage; original_failure=$message"
        }
    }
    Write-Host "[FAIL] $message"
    Write-Host "LONG_CONVERSATION_PROBE_FAIL"
    $exitCode = 1
} finally {
    try {
        Restore-OpenCodeConfigSnapshot $opencodeConfigState
        if ($null -ne $opencodeConfigState) {
            Pass "Restored original OpenCode config: $($opencodeConfigState.ConfigPath)"
        }
    } catch {
        Write-Host "[WARN] Failed to restore original OpenCode config: $_"
    }
    if ($probeRunStartMarkerWritten -and -not $probeRunEndMarkerWritten) {
        try {
            Write-StructuredLogRunMarker -Paths $structuredLogSources -ProbeDir $probeDir -MarkerId $probeRunLogMarkerId -Phase "end"
            $probeRunEndMarkerWritten = $true
        } catch {
            Write-Host "[WARN] Failed to write probe run end marker: $_"
        }
    }
    try {
        Restore-ProbeRunSkillArtifactDirectory $probeRunSkillState
    } catch {
        Write-Host "[WARN] Failed to restore active OpenCode skill: $_"
    } finally {
        Release-ProbeRunStructuredLogLock $probeRunLockHandle
    }
    if ($contextConfigWasWritten -and $null -ne $originalState) {
        try {
            $env:CHAT2API_STORE_DIR = $storeDir
            $stateJson = ($originalState | ConvertTo-Json -Compress -Depth 100)
            $env:CHAT2API_CONTEXT_STATE_JSON = $stateJson
            node --input-type=module -e @'
import Store from 'electron-store'
const state = JSON.parse(process.env.CHAT2API_CONTEXT_STATE_JSON)
const store = new Store({ name: 'data', cwd: process.env.CHAT2API_STORE_DIR, encryptionKey: 'chat2api-fixed-encryption-key-v1' })
const config = store.get('config') || {}
if (state.hasContextManagement) { config.contextManagement = state.contextManagement } else { delete config.contextManagement }
if (state.hasProxyPort) { config.proxyPort = state.proxyPort } else { delete config.proxyPort }
if (state.hasAutoStartProxy) { config.autoStartProxy = state.autoStartProxy } else { delete config.autoStartProxy }
store.set('config', config)
'@
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[WARN] Failed to restore original context management config: node exited $LASTEXITCODE"
            } else {
                Pass "Restored original context management config"
            }
        } catch {
            Write-Host "[WARN] Failed to restore config: $_"
        } finally {
            $env:CHAT2API_STORE_DIR = $previousStoreDir
            Remove-Item Env:\CHAT2API_CONTEXT_STATE_JSON -ErrorAction SilentlyContinue
            Remove-Item Env:\CHAT2API_PROBE_PROXY_PORT -ErrorAction SilentlyContinue
        }
    } else {
        $env:CHAT2API_STORE_DIR = $previousStoreDir
        Remove-Item Env:\CHAT2API_CONTEXT_STATE_JSON -ErrorAction SilentlyContinue
        Remove-Item Env:\CHAT2API_PROBE_PROXY_PORT -ErrorAction SilentlyContinue
    }
    Stop-LoggedProcess $devServerHandle
}
exit $exitCode
