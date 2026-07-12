param(
    [Parameter(Mandatory=$true)]
    [string]$Model,

    [string]$LogPath = ".\dev.log",

    [string]$PromptPath = "tests/agent-capability/long-conversation-contamination.md",

    [int]$TimeoutSeconds = 240,

    [int]$ContextMaxMessages = 12,

    [int]$SummaryKeepRecentMessages = 6,

    [int]$WarmupTurns = 6
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    Write-Host "LONG_CONVERSATION_PROBE_FAIL"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function ConvertTo-StableJson($Value) {
    return $Value | ConvertTo-Json -Compress -Depth 20
}

function Test-ContainsAny([string]$Text, [string[]]$Needles) {
    foreach ($needle in $Needles) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Read-JsonFile([string]$Path) {
    try {
        return Get-Content -Raw $Path | ConvertFrom-Json
    } catch {
        Fail "Failed to parse JSON file $Path : $_"
    }
}

function Write-JsonFile([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function ConvertTo-NativeProcessArgumentString([string[]]$Arguments) {
    $escaped = foreach ($argument in $Arguments) {
        if ($null -eq $argument -or $argument.Length -eq 0) {
            '""'
            continue
        }

        if ($argument -notmatch '[\s"]') {
            $argument
            continue
        }

        '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    }

    return $escaped -join ' '
}

function Resolve-OpencodeExecutablePath([string]$CandidatePath) {
    if (-not [string]::IsNullOrWhiteSpace($CandidatePath) -and (Test-Path $CandidatePath)) {
        $extension = [System.IO.Path]::GetExtension($CandidatePath)
        if ([string]::Equals($extension, ".exe", [StringComparison]::OrdinalIgnoreCase)) {
            return (Resolve-Path $CandidatePath).Path
        }
    }

    $commonCandidates = @(
        (Join-Path $HOME "AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe"),
        (Join-Path $HOME "AppData\Roaming\npm\opencode.cmd"),
        (Join-Path $HOME "AppData\Roaming\npm\opencode.ps1")
    )

    foreach ($path in $commonCandidates) {
        if (Test-Path $path) {
            return (Resolve-Path $path).Path
        }
    }

    return $CandidatePath
}

function Invoke-OpencodeRun {
    param(
        [string]$Executable,
        [string]$Prompt,
        [string]$ModelName,
        [int]$TimeoutSeconds,
        [string]$SessionId = ""
    )

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $Executable
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.CreateNoWindow = $true
    $args = @(
        "run",
        "--model", $ModelName,
        "--agent", "long-conversation-probe",
        "--format", "json",
        "--dir", ".",
        "--auto"
    )
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        $args += @("--session", $SessionId)
    }

    $argumentList = $processInfo.ArgumentList
    if ($null -ne $argumentList) {
        foreach ($arg in $args) {
            $argumentList.Add($arg) | Out-Null
        }
    } else {
        $processInfo.Arguments = ConvertTo-NativeProcessArgumentString $args
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    $process.Start() | Out-Null
    $process.StandardInput.Write($Prompt)
    $process.StandardInput.Close()

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $timedOut = $false
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $timedOut = $true
        try {
            $process.Kill($true)
        } catch {
            try { $process.Kill() } catch {}
        }
        $process.WaitForExit() | Out-Null
    }

    return [ordered]@{
        TimedOut = $timedOut
        ExitCode = if ($timedOut) { $null } else { $process.ExitCode }
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

function Get-SessionIdFromEvents([string]$EventText) {
    foreach ($line in ($EventText -split "`r?`n")) {
        if ($line.Trim().Length -eq 0) {
            continue
        }

        try {
            $event = $line | ConvertFrom-Json
        } catch {
            continue
        }

        $sessionId = [string]$event.sessionID
        if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
            return $sessionId
        }
    }

    return ""
}

function Add-EventTextToFile([string]$Path, [string]$EventText) {
    if ([string]::IsNullOrWhiteSpace($EventText)) {
        return
    }

    $normalized = $EventText.TrimEnd()
    if ($normalized.Length -eq 0) {
        return
    }

    [System.IO.File]::AppendAllText($Path, $normalized + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Get-NewLogText([string]$LogPath, [int]$BeforeLineCount) {
    $afterLogLines = @()
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $afterLogLines = @(Get-Content $LogPath)
        if ($afterLogLines.Count -gt $BeforeLineCount) {
            break
        }
        Start-Sleep -Seconds 1
    }

    if ($afterLogLines.Count -gt $BeforeLineCount) {
        return ($afterLogLines | Select-Object -Skip $BeforeLineCount) -join [Environment]::NewLine
    }

    return ""
}

function Test-HasSummaryCompactionEvidence([string]$LogText) {
    return $LogText.IndexOf("[ContextManagementService] Strategy summary trimmed", [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-HasSlidingCompactionEvidence([string]$LogText) {
    return $LogText.IndexOf("[ContextManagementService] Strategy slidingWindow trimmed", [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Read-ContextManagementState([string]$StoreDir) {
    $oldStoreDir = $env:CHAT2API_STORE_DIR
    try {
        $env:CHAT2API_STORE_DIR = $StoreDir
        $json = node --input-type=module -e @'
import Store from 'electron-store'

const store = new Store({
  name: 'data',
  cwd: process.env.CHAT2API_STORE_DIR,
  encryptionKey: 'chat2api-fixed-encryption-key-v1',
})
const config = store.get('config') || {}
const hasContextManagement = Object.prototype.hasOwnProperty.call(config, 'contextManagement')
console.log(JSON.stringify({
  hasContextManagement,
  value: hasContextManagement ? config.contextManagement : null,
}))
'@
        if ($LASTEXITCODE -ne 0) {
            Fail "Failed to read context management config via electron-store"
        }
        return $json | ConvertFrom-Json
    } finally {
        $env:CHAT2API_STORE_DIR = $oldStoreDir
    }
}

function Write-ContextManagementState([string]$StoreDir, $State) {
    $oldStoreDir = $env:CHAT2API_STORE_DIR
    $oldStateJson = $env:CHAT2API_CONTEXT_STATE_JSON
    try {
        $env:CHAT2API_STORE_DIR = $StoreDir
        $env:CHAT2API_CONTEXT_STATE_JSON = $State | ConvertTo-Json -Compress -Depth 100
        node --input-type=module -e @'
import Store from 'electron-store'

const state = JSON.parse(process.env.CHAT2API_CONTEXT_STATE_JSON)
const store = new Store({
  name: 'data',
  cwd: process.env.CHAT2API_STORE_DIR,
  encryptionKey: 'chat2api-fixed-encryption-key-v1',
})
const config = store.get('config') || {}
if (state.hasContextManagement) {
  config.contextManagement = state.value
} else {
  delete config.contextManagement
}
store.set('config', config)
'@
        if ($LASTEXITCODE -ne 0) {
            Fail "Failed to write context management config via electron-store"
        }
    } finally {
        $env:CHAT2API_STORE_DIR = $oldStoreDir
        $env:CHAT2API_CONTEXT_STATE_JSON = $oldStateJson
    }
}

Write-Host "============================================"
Write-Host " Chat2API Long Conversation Compaction Probe"
Write-Host " Model: $Model"
Write-Host " Context: slidingWindow.maxMessages=$ContextMaxMessages summary.keepRecentMessages=$SummaryKeepRecentMessages"
Write-Host " Warmup turns: $WarmupTurns"
Write-Host "============================================"

$probeDir = ".agent-probe"
if (Test-Path $probeDir) {
    Remove-Item -Recurse -Force $probeDir
}
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null

$eventsPath = "$probeDir/opencode-long-events.ndjson"
$finalEventsPath = "$probeDir/opencode-long-final-events.ndjson"
$stderrPath = "$probeDir/opencode-long-stderr.log"
$step1Path = "$probeDir/long-step-1.txt"
$step2Path = "$probeDir/long-step-2.txt"
$summaryPath = "$probeDir/long-summary.txt"
$resultPath = "$probeDir/long-result.json"
$metaPath = "$probeDir/long-meta.json"
$storeDir = Join-Path $HOME ".chat2api"

if (-not (Test-Path $promptPath)) { Fail "Prompt file not found: $promptPath" }
if (-not (Test-Path $LogPath)) { Fail "Log file not found: $LogPath" }
if (-not (Test-Path $storeDir)) { Fail "Config store directory not found: $storeDir" }
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { Fail "opencode command not found in PATH" }

$originalContextState = Read-ContextManagementState $storeDir
$aggressiveContextState = [ordered]@{
    hasContextManagement = $true
    value = [ordered]@{
    enabled = $true
    strategies = [ordered]@{
        slidingWindow = [ordered]@{
            enabled = $true
            maxMessages = $ContextMaxMessages
        }
        tokenLimit = [ordered]@{
            enabled = $false
            maxTokens = 4000
        }
        summary = [ordered]@{
            enabled = $true
            keepRecentMessages = $SummaryKeepRecentMessages
            summaryPrompt = "Summarize the earlier conversation as procedural state for an in-progress tool workflow. Preserve exact pending probe obligations, required file paths, remaining tool sequence, and any tool-result facts needed to continue. Do not answer the conversation. Do not add chit-chat, time, greetings, or status filler."
        }
    }
    executionOrder = @("summary", "slidingWindow")
    }
}

$beforeLogLines = @(Get-Content $LogPath)
$prompt = Get-Content -Raw $promptPath

try {
    Write-ContextManagementState $storeDir $aggressiveContextState
    Pass "Temporarily enabled aggressive context management in config store"

    Write-Host "Running OpenCode..."
    $opencodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
    if (-not $opencodeCommand) {
        Fail "opencode command not found in PATH"
    }

    $opencodeExecutable = Resolve-OpencodeExecutablePath $opencodeCommand.Source
    [System.IO.File]::WriteAllText($eventsPath, "", [System.Text.UTF8Encoding]::new($false))

    $sessionId = ""
    for ($turn = 1; $turn -le $WarmupTurns; $turn++) {
        $warmupPrompt = "Compaction warmup turn $turn. Reply exactly WARMUP_ACK_$turn and do not use tools."
        $warmupResult = Invoke-OpencodeRun -Executable $opencodeExecutable -Prompt $warmupPrompt -ModelName $Model -TimeoutSeconds $TimeoutSeconds -SessionId $sessionId
        [System.IO.File]::WriteAllText("$probeDir/opencode-long-warmup-$turn.ndjson", [string]$warmupResult.Stdout, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText("$probeDir/opencode-long-warmup-$turn.stderr.log", [string]$warmupResult.Stderr, [System.Text.UTF8Encoding]::new($false))
        Add-EventTextToFile $eventsPath ([string]$warmupResult.Stdout)

        if ($warmupResult.TimedOut) {
            Fail "opencode_warmup_timeout: warmup turn $turn did not exit within $TimeoutSeconds seconds"
        }
        if ($warmupResult.ExitCode -ne 0) {
            Fail "opencode warmup turn $turn exited with code $($warmupResult.ExitCode)"
        }

        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            $sessionId = Get-SessionIdFromEvents ([string]$warmupResult.Stdout)
            if ([string]::IsNullOrWhiteSpace($sessionId)) {
                Fail "Could not determine OpenCode session id from warmup turn $turn events"
            }
        }
    }
    Pass "Completed $WarmupTurns OpenCode warmup turns in session $sessionId"

    $postWarmupLogText = Get-NewLogText $LogPath $beforeLogLines.Count
    $warmupSummaryEvidence = Test-HasSummaryCompactionEvidence $postWarmupLogText
    $warmupSlidingEvidence = Test-HasSlidingCompactionEvidence $postWarmupLogText
    if (-not $warmupSummaryEvidence -and -not $warmupSlidingEvidence) {
        Fail "No compaction evidence found after warmup turns; refusing to run final tool probe without post-compaction precondition"
    }
    if ($postWarmupLogText.IndexOf("[Forwarder] Context management applied:", [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Fail "Forwarder did not report context-management application after warmup turns"
    }
    Pass "dev.log proves compaction before final tool probe (summary=$warmupSummaryEvidence sliding=$warmupSlidingEvidence)"

    $runResult = Invoke-OpencodeRun -Executable $opencodeExecutable -Prompt $prompt -ModelName $Model -TimeoutSeconds $TimeoutSeconds -SessionId $sessionId
    [System.IO.File]::WriteAllText($finalEventsPath, [string]$runResult.Stdout, [System.Text.UTF8Encoding]::new($false))
    Add-EventTextToFile $eventsPath ([string]$runResult.Stdout)
    [System.IO.File]::WriteAllText($stderrPath, [string]$runResult.Stderr, [System.Text.UTF8Encoding]::new($false))

    if ($runResult.TimedOut) {
        $partialOutput = [string]$runResult.Stdout
        $finalDoneSeenBeforeExit = $partialOutput.IndexOf("LONG_CONVERSATION_PROBE_DONE", [StringComparison]::OrdinalIgnoreCase) -ge 0
        $step1Exists = Test-Path $step1Path
        $step2Exists = Test-Path $step2Path
        $summaryExists = Test-Path $summaryPath

        if ($summaryExists -and $finalDoneSeenBeforeExit) {
            Fail "opencode_turn_timeout_after_final_marker: OpenCode emitted the final marker and wrote long-summary.txt but did not exit within $TimeoutSeconds seconds"
        }
        if ($step2Exists) {
            Fail "opencode_turn_timeout_after_mid_probe_progress: OpenCode reached long-step-2.txt but did not exit within $TimeoutSeconds seconds"
        }
        if ($step1Exists) {
            Fail "opencode_turn_timeout_after_initial_tool_progress: OpenCode reached long-step-1.txt but did not exit within $TimeoutSeconds seconds"
        }
        Fail "opencode_turn_timeout_before_required_artifacts: OpenCode did not exit within $TimeoutSeconds seconds and no required probe artifacts were created"
    }

    if ($runResult.ExitCode -ne 0) {
        Fail "opencode exited with code $($runResult.ExitCode)"
    }
    Pass "OpenCode exited successfully"

    $earlyEventLines = Get-Content $finalEventsPath | Where-Object { $_.Trim().Length -gt 0 }
    $earlySkillSeen = $false
    $earlyReadSeen = $false
    $earlyBashSeen = $false
    $earlyNonSkillToolCount = 0
    $earlyFinalDoneSeen = $false
    $earlyPartialBashTextSeen = $false
    foreach ($line in $earlyEventLines) {
        try {
            $event = $line | ConvertFrom-Json
        } catch {
            continue
        }

        if ([string]$event.type -eq "tool_use") {
            $toolName = [string]$event.part.tool
            if ([string]::Equals($toolName, "skill", [StringComparison]::OrdinalIgnoreCase)) {
                if ((ConvertTo-StableJson $event).IndexOf("long-conversation-probe", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $earlySkillSeen = $true
                }
            } elseif ([string]::Equals($toolName, "read", [StringComparison]::OrdinalIgnoreCase)) {
                $earlyReadSeen = $true
                $earlyNonSkillToolCount += 1
            } elseif ([string]::Equals($toolName, "bash", [StringComparison]::OrdinalIgnoreCase)) {
                $earlyBashSeen = $true
                $earlyNonSkillToolCount += 1
            } elseif (-not [string]::IsNullOrWhiteSpace($toolName)) {
                $earlyNonSkillToolCount += 1
            }
        }

        if ([string]$event.type -eq "text") {
            $eventText = [string]$event.part.text
            if ($eventText.IndexOf("LONG_CONVERSATION_PROBE_DONE", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $earlyFinalDoneSeen = $true
            }
            if (
                ($eventText.IndexOf("step 2", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $eventText.IndexOf("bash command", [StringComparison]::OrdinalIgnoreCase) -ge 0) `
                -and $eventText.IndexOf("<|CHAT2API|parameter>", [StringComparison]::OrdinalIgnoreCase) -ge 0
            ) {
                $earlyPartialBashTextSeen = $true
            }
        }
    }

    if ($earlySkillSeen -and $earlyFinalDoneSeen -and $earlyNonSkillToolCount -eq 0 -and -not (Test-Path $step1Path)) {
        Fail "skill_result_then_final_marker_without_required_tools: model loaded long-conversation-probe, then emitted LONG_CONVERSATION_PROBE_DONE without any structured read/bash tool_use events"
    }
    if ($earlySkillSeen -and $earlyReadSeen -and -not $earlyBashSeen -and $earlyPartialBashTextSeen -and -not (Test-Path $step1Path)) {
        Fail "read_succeeded_then_partial_bash_text_without_tool_use: model completed the required read step, then emitted plain text plus trailing CHAT2API XML residue instead of a real bash tool_use"
    }

    if (-not (Test-Path $step1Path)) { Fail "Missing $step1Path" }
    if (-not (Test-Path $step2Path)) { Fail "Missing $step2Path" }
    if (-not (Test-Path $summaryPath)) { Fail "Missing $summaryPath" }
    if (-not (Test-Path $resultPath)) { Fail "Missing $resultPath" }
    Pass "Probe artifact files were created"

    Write-JsonFile $metaPath ([ordered]@{
        model = $Model
        promptPath = $PromptPath
        summaryInjectionShape = "system-isolated"
        probe = "long-conversation"
    })
    Pass "Probe metadata captured"

    $resultJson = Read-JsonFile $resultPath
    if ([string]::IsNullOrWhiteSpace([string]$resultJson.skill)) {
        Fail "long-result.json is missing a skill field"
    }
    Pass "long-result.json is structurally valid"

    $eventLines = Get-Content $finalEventsPath | Where-Object { $_.Trim().Length -gt 0 }
    if ($eventLines.Count -eq 0) {
        Fail "OpenCode event log is empty"
    }

    $events = New-Object System.Collections.Generic.List[object]
    foreach ($line in $eventLines) {
        try {
            $events.Add(($line | ConvertFrom-Json))
        } catch {
            Fail "OpenCode event log contains non-JSON line: $line"
        }
    }
    Pass "OpenCode event log is valid NDJSON"

    $skillNeedles = @("long-conversation-probe", '"skill"')
    $toolCallNeedles = @("tool_use", "tool_call", "toolcall", "tool_call_delta", "call_tool", "tool.start", "tool.starting", "tool:call", "function_call")
    $toolResultNeedles = @("tool_result", "toolresult", "observation", "tool.finish", "tool.finished", "tool:result", '"status":"completed"', '"state":{"status":"completed"')
    $nonSkillToolNames = @("read", "bash", "read_file", "Get-Content")

    $skillCallSeen = $false
    $nonSkillToolCallCount = 0
    $toolResultSeen = $false
    $nonSkillToolAfterResultSeen = $false
    $finalDoneSeen = $false
    $payloadReadSeen = $false

    foreach ($event in $events) {
        $text = ConvertTo-StableJson $event

        if ($text.Contains("LONG_CONVERSATION_PROBE_DONE")) {
            $finalDoneSeen = $true
        }

        if ((Test-ContainsAny $text $skillNeedles) -and (Test-ContainsAny $text $toolCallNeedles)) {
            $skillCallSeen = $true
        }

        if ($text.IndexOf("long-conversation-payload.txt", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $payloadReadSeen = $true
        }

        $looksLikeToolCall = Test-ContainsAny $text $toolCallNeedles
        $looksLikeToolResult = Test-ContainsAny $text $toolResultNeedles
        $looksLikeNonSkillTool = (Test-ContainsAny $text $nonSkillToolNames) -and -not ($text.Contains("long-conversation-probe") -and $text.Contains('"skill"'))

        if ($looksLikeToolResult) {
            $toolResultSeen = $true
        }

        if ($looksLikeToolCall -and $looksLikeNonSkillTool) {
            $nonSkillToolCallCount += 1
            if ($toolResultSeen) {
                $nonSkillToolAfterResultSeen = $true
            }
        }
    }

    if (-not $skillCallSeen) {
        Fail "No real skill tool call for long-conversation-probe found in OpenCode events"
    }
    if ($nonSkillToolCallCount -lt 8) {
        Fail "Expected at least 8 non-skill tool calls, found $nonSkillToolCallCount"
    }
    if (-not $nonSkillToolAfterResultSeen) {
        Fail "No non-skill tool call found after a tool result/observation event"
    }
    if (-not $payloadReadSeen) {
        Fail "OpenCode event stream never referenced long-conversation-payload.txt"
    }
    if (-not $finalDoneSeen) {
        Fail "Final assistant output did not contain LONG_CONVERSATION_PROBE_DONE"
    }
    Pass "OpenCode event stream proves a long multi-turn tool session"

    $driftText = Get-Content -Raw $eventsPath
    if ($driftText.IndexOf("summary_contamination", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Fail "OpenCode event stream contained availability drift subkind summary_contamination"
    }
    $forbiddenToolNames = @("Burp Suite MCP", "GitHub Integration", "Context7", "Task Agents")
    foreach ($toolName in $forbiddenToolNames) {
        if ($driftText.IndexOf($toolName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Fail "Probe output/event stream mentioned non-authoritative tool name: $toolName"
        }
    }
    Pass "No summary_contamination drift or fabricated tool inventory leaked into the probe output"

    $newLogText = Get-NewLogText $LogPath $beforeLogLines.Count

    if ($newLogText.Length -eq 0) {
        Fail "No new dev.log content was captured during the probe"
    }

    $summaryEvidence = Test-HasSummaryCompactionEvidence $newLogText
    $slidingEvidence = Test-HasSlidingCompactionEvidence $newLogText
    if (-not $summaryEvidence -and -not $slidingEvidence) {
        Fail "No summary or sliding-window compaction evidence found in appended dev.log output"
    }
    if ($newLogText.IndexOf("[Forwarder] Context management applied:", [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Fail "Forwarder did not report context-management application in appended dev.log output"
    }
    if ($newLogText.IndexOf('"hasManagedToolContract":true', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Fail "Qwen request assembly trace did not show managed tool contract after compaction"
    }
    Pass "dev.log proves compaction occurred before real tool execution (summary=$summaryEvidence sliding=$slidingEvidence)"

    Write-Host "CAPABILITY_PROBE_PASS"
    Write-Host "LONG_CONVERSATION_PROBE_PASS"
    exit 0
}
finally {
    try {
        Write-ContextManagementState $storeDir $originalContextState
        Write-Host "[PASS] Restored original context management config"
    } catch {
        Write-Host "[WARN] Failed to restore original context management config: $_"
    }
}
