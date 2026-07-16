param(
    [Parameter(Mandatory = $true)]
    [string]$Model,

    [int]$Runs = 1,

    [string]$LogPath = ".\dev.log",

    [string]$AnthropicBaseUrl = "http://127.0.0.1:8081/v1",

    [string]$ClaudeCommand = "claude",

    [int]$TurnTimeoutSeconds = 120,

    [ValidateSet("resume", "continue", "none")]
    [string]$ResumeMode = "resume",

    [string]$CompactPrompt = "/compact",

    [string[]]$ClaudeArgs = @("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions")
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Write-Utf8NoBomFile([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Read-Utf8Lines([string]$Path) {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $false)
    $fileStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = [System.IO.StreamReader]::new($fileStream, $utf8, $true)
        try {
            $lines = New-Object System.Collections.Generic.List[string]
            while (-not $reader.EndOfStream) {
                $lines.Add($reader.ReadLine()) | Out-Null
            }
            return $lines.ToArray()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $fileStream.Dispose()
    }
}

function Write-ProbeStatusArtifact(
    [string]$Status,
    [string]$Message,
    [string]$FailureKind = $null
) {
    if (-not $script:ProbeRoot) {
        return
    }

    $payload = [ordered]@{
        status = $Status
        message = $Message
        failureKind = $FailureKind
        model = $script:CurrentModel
        run = $script:CurrentRun
        turn = $script:CurrentTurnName
        eventPath = $script:CurrentEventPath
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    Write-Utf8NoBomFile `
        -Path (Join-Path $script:ProbeRoot "probe-status.json") `
        -Text ($payload | ConvertTo-Json -Depth 20)
}

function Fail([string]$Message) {
    Write-ProbeStatusArtifact "failed" $Message
    Write-Host "[FAIL] $Message"
    Write-Host "CLAUDE_COMPACT_TOOL_CONTINUITY_FAIL"
    exit 1
}

function Write-ClassifiedFailureArtifact([string]$FailureKind, [string]$Message) {
    $payload = [ordered]@{
        failureKind = $FailureKind
        message = $Message
        model = $script:CurrentModel
        run = $script:CurrentRun
        turn = $script:CurrentTurnName
        eventPath = $script:CurrentEventPath
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }

    $json = $payload | ConvertTo-Json -Depth 20
    if ($script:CurrentRunDir -and (Test-Path $script:CurrentRunDir)) {
        Write-Utf8NoBomFile `
            -Path (Join-Path $script:CurrentRunDir "classified-failure.json") `
            -Text $json
    }

    if ($script:ProbeRoot -and (Test-Path $script:ProbeRoot)) {
        Write-Utf8NoBomFile `
            -Path (Join-Path $script:ProbeRoot "last-classified-failure.json") `
            -Text $json
    }
}

function Fail-Classified([string]$FailureKind, [string]$Message) {
    Write-ClassifiedFailureArtifact $FailureKind $Message
    Write-ProbeStatusArtifact "failed" $Message $FailureKind
    Write-Host "[FAIL][$FailureKind] $Message"
    Write-Host "CLAUDE_COMPACT_TOOL_CONTINUITY_FAIL"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function ConvertTo-StableJson($Value) {
    return $Value | ConvertTo-Json -Compress -Depth 30
}

function Test-ContainsAny([string]$Text, [string[]]$Needles) {
    foreach ($needle in $Needles) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Resolve-ClaudeCommandPath([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $null
    }

    if (Test-Path $Candidate) {
        return (Resolve-Path $Candidate).Path
    }

    $command = Get-Command $Candidate -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $commonCandidates = @(
        (Join-Path $HOME "AppData\Roaming\npm\claude.cmd"),
        (Join-Path $HOME "AppData\Local\Programs\Claude\claude.exe"),
        (Join-Path $HOME ".npm-global\claude.cmd")
    )

    foreach ($path in $commonCandidates) {
        if (Test-Path $path) {
            return (Resolve-Path $path).Path
        }
    }

    return $null
}

function ConvertTo-NativeProcessArgumentString([string[]]$Arguments) {
    $escaped = foreach ($argument in $Arguments) {
        if ($null -eq $argument) {
            '""'
            continue
        }

        if ($argument.Length -eq 0) {
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

function Invoke-ClaudeTurn {
    param(
        [string]$Executable,
        [string]$Prompt,
        [string]$OutputPath,
        [string]$StderrPath,
        [string]$ModelName,
        [string]$BaseUrl,
        [string]$SessionId,
        [string]$ResumeBehavior,
        [string[]]$ExtraArgs,
        [int]$TimeoutSeconds
    )

    $oldBaseUrl = $env:ANTHROPIC_BASE_URL
    $stdoutTempPath = [System.IO.Path]::GetTempFileName()
    $stderrTempPath = [System.IO.Path]::GetTempFileName()
    try {
        $env:ANTHROPIC_BASE_URL = $BaseUrl
        $args = @("-p", $Prompt, "--model", $ModelName)
        if ($ExtraArgs) {
            $args += $ExtraArgs
        }
        if ($ResumeBehavior -eq "resume" -and -not [string]::IsNullOrWhiteSpace($SessionId)) {
            $args += @("--resume", $SessionId)
        } elseif ($ResumeBehavior -eq "continue") {
            $args += "--continue"
        }

        $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $processInfo.FileName = $Executable
        $processInfo.UseShellExecute = $false
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        $processInfo.CreateNoWindow = $true
        $processInfo.Environment["ANTHROPIC_BASE_URL"] = $BaseUrl
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

        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        $combinedParts = @($stdoutText, $stderrText) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $combinedText = $combinedParts -join [Environment]::NewLine
        $exitCode = if ($timedOut) { $null } else { $process.ExitCode }
        Write-Utf8NoBomFile -Path $OutputPath -Text $stdoutText
        Write-Utf8NoBomFile -Path $StderrPath -Text $stderrText
        return [ordered]@{
            ExitCode = $exitCode
            TimedOut = $timedOut
            Output = $stdoutText
            ErrorOutput = $stderrText
            CombinedOutput = $combinedText
        }
    } finally {
        $env:ANTHROPIC_BASE_URL = $oldBaseUrl
        Remove-Item $stdoutTempPath, $stderrTempPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-SessionIdFromText([string]$Text) {
    $patterns = @(
        '"session_id"\s*:\s*"([^"]+)"',
        '"sessionId"\s*:\s*"([^"]+)"',
        '"conversation_id"\s*:\s*"([^"]+)"',
        '"conversationId"\s*:\s*"([^"]+)"'
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($Text, $pattern)
        if ($match.Success) {
            return $match.Groups[1].Value
        }
    }

    return $null
}

function Read-NdjsonObjects([string]$Path) {
    if (-not (Test-Path $Path)) {
        return [ordered]@{
            Ok = $false
            FailureKind = "missing_event_log"
            Message = "Event log file does not exist: $Path"
            Events = $null
        }
    }

    $lines = @(Read-Utf8Lines $Path) | Where-Object { $_.Trim().Length -gt 0 }
    if ($lines.Count -eq 0) {
        return [ordered]@{
            Ok = $false
            FailureKind = "empty_event_stream"
            Message = "Event log is empty: $Path"
            Events = $null
        }
    }

    $events = New-Object System.Collections.Generic.List[object]
    foreach ($line in $lines) {
        try {
            $events.Add(($line | ConvertFrom-Json))
        } catch {
            return [ordered]@{
                Ok = $false
                FailureKind = "invalid_event_json"
                Message = "Event log contains non-JSON line in $Path : $line"
                Events = $null
            }
        }
    }

    return [ordered]@{
        Ok = $true
        FailureKind = $null
        Message = $null
        Events = $events
    }
}

function Try-ReadNdjsonObjects([string]$Path) {
    $result = Read-NdjsonObjects $Path
    if (-not $result.Ok) {
        return $null
    }
    return $result.Events
}

function Test-ToolNameMatch($Candidate, [string[]]$ToolNames) {
    if ([string]::IsNullOrWhiteSpace([string]$Candidate)) {
        return $false
    }

    foreach ($toolName in $ToolNames) {
        if ([string]::Equals([string]$Candidate, $toolName, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Get-ClaudeToolEvidence($Events, [string[]]$ToolNames) {
    $toolUseSeen = $false
    $toolResultSeen = $false
    $seenToolUseIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    foreach ($event in $Events) {
        $eventType = [string]$event.type

        if ($eventType -eq "tool_use") {
            $part = $event.part
            $toolName = [string]$part.tool
            if (Test-ToolNameMatch $toolName $ToolNames) {
                $toolUseSeen = $true
                if (-not [string]::IsNullOrWhiteSpace([string]$part.callID)) {
                    $seenToolUseIds.Add([string]$part.callID) | Out-Null
                }
                if ([string]::Equals([string]$part.state.status, "completed", [StringComparison]::OrdinalIgnoreCase)) {
                    $toolResultSeen = $true
                }
            }
        }

        $messageContent = @($event.message.content)
        foreach ($contentPart in $messageContent) {
            $contentType = [string]$contentPart.type
            if ($contentType -eq "tool_use" -and (Test-ToolNameMatch ([string]$contentPart.name) $ToolNames)) {
                $toolUseSeen = $true
                if (-not [string]::IsNullOrWhiteSpace([string]$contentPart.id)) {
                    $seenToolUseIds.Add([string]$contentPart.id) | Out-Null
                }
            }
            if ($contentType -eq "tool_result") {
                $toolUseId = [string]$contentPart.tool_use_id
                if ($toolUseSeen -and ([string]::IsNullOrWhiteSpace($toolUseId) -or $seenToolUseIds.Contains($toolUseId))) {
                    $toolResultSeen = $true
                }
            }
        }
    }

    return [ordered]@{
        ToolUseSeen = $toolUseSeen
        ToolResultSeen = $toolResultSeen
    }
}

function Test-ClaudeResultCompleted($Events) {
    foreach ($event in $Events) {
        if ([string]$event.type -ne "result") {
            continue
        }

        if (
            [string]::Equals([string]$event.subtype, "success", [StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals([string]$event.terminal_reason, "completed", [StringComparison]::OrdinalIgnoreCase)
        ) {
            return $true
        }
    }

    return $false
}

function Assert-NoToolLossText([string]$Text, [string]$Label) {
    $forbidden = @(
        "only current time",
        "only one tool",
        "tools are unavailable",
        "bash is unavailable",
        "read is unavailable",
        "not in allowed_tools",
        "do not have bash",
        "do not have read",
        "provider refused the authoritative tool catalog",
        "没有可用的 bash 工具",
        "没有可用的 read 工具",
        "无法访问本地文件系统路径",
        "仅具备文档检索和网页解析能力"
    )
    foreach ($needle in $forbidden) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Fail "$Label contained forbidden tool-loss text: $needle"
        }
    }
}

function Get-ToolLossNeedle([string]$Text) {
    $forbidden = @(
        "only current time",
        "only one tool",
        "tools are unavailable",
        "bash is unavailable",
        "read is unavailable",
        "not in allowed_tools",
        "do not have bash",
        "do not have read",
        "provider refused the authoritative tool catalog",
        "没有可用的 bash 工具",
        "没有可用的 read 工具",
        "无法访问本地文件系统路径",
        "仅具备文档检索和网页解析能力"
    )
    foreach ($needle in $forbidden) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $needle
        }
    }
    return $null
}

function Get-AppendedLogText([string]$Path, [string[]]$BeforeLines) {
    $afterLines = @()
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $afterLines = @(Read-Utf8Lines $Path)
        if ($afterLines.Count -gt $BeforeLines.Count) {
            break
        }
        Start-Sleep -Seconds 1
    }

    if ($afterLines.Count -le $BeforeLines.Count) {
        return ""
    }

    return (($afterLines | Select-Object -Skip $BeforeLines.Count) -join [Environment]::NewLine)
}

Write-Host "============================================"
Write-Host " Claude Code Compact Tool Continuity Probe"
Write-Host " Model: $Model"
Write-Host " Runs : $Runs"
Write-Host "============================================"

$script:CurrentModel = $Model
$script:CurrentRun = $null
$script:CurrentRunDir = $null
$script:CurrentTurnName = $null
$script:CurrentEventPath = $null
$script:ProbeRoot = $null

if ($Runs -lt 1) { Fail "Runs must be >= 1" }
if (-not (Test-Path $LogPath)) { Fail "Log file not found: $LogPath" }

$claudeExecutable = Resolve-ClaudeCommandPath $ClaudeCommand
if (-not $claudeExecutable) {
    Fail "Could not resolve Claude CLI command '$ClaudeCommand'. Pass -ClaudeCommand with a full path, for example the local claude.cmd or claude.exe."
}
Pass "Resolved Claude CLI: $claudeExecutable"

$probeRoot = ".agent-probe/claude-compact"
if (Test-Path $probeRoot) {
    Remove-Item -Recurse -Force $probeRoot
}
New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
$script:ProbeRoot = $probeRoot

$modelSlug = ($Model -replace '[^A-Za-z0-9._-]+', '_')
$allRunSummaries = New-Object System.Collections.Generic.List[object]

for ($run = 1; $run -le $Runs; $run++) {
    Write-Host "--------------------------------------------"
    Write-Host " Run $run/$Runs"
    Write-Host "--------------------------------------------"

    $runDir = Join-Path $probeRoot ("{0}__run{1}" -f $modelSlug, $run)
    New-Item -ItemType Directory -Force -Path $runDir | Out-Null
    $script:CurrentRun = $run
    $script:CurrentRunDir = $runDir

    $preBashFile = ".agent-probe/claude-pre.txt"
    $postBashFile = ".agent-probe/claude-post.txt"
    foreach ($path in @($preBashFile, $postBashFile)) {
        if (Test-Path $path) {
            Remove-Item -Force $path
        }
    }
    New-Item -ItemType Directory -Force -Path ".agent-probe" | Out-Null

    $beforeLogLines = @(Read-Utf8Lines $LogPath)
    $sessionId = $null
    $establishedSessionId = $null
    $turnSummaries = New-Object System.Collections.Generic.List[object]

    $turns = @(
        [ordered]@{
            Name = "pre-read"
            Prompt = "Use the Read tool on tests/agent-capability/input.txt. Do not answer from memory. After the tool result, reply with exactly PRE_COMPACT_READ_OK."
            ExpectedToolNames = @("Read", "read")
            ExpectedMarker = ""
        },
        [ordered]@{
            Name = "pre-bash"
            Prompt = "Use the Bash tool exactly once. The command must create the local verification file .agent-probe/claude-pre.txt containing exactly PRE_COMPACT_BASH_OK, and it must also print exactly PRE_COMPACT_BASH_STDOUT to stdout so the tool result is unambiguous. Do not call Bash a second time. After the tool result, reply with exactly PRE_COMPACT_BASH_DONE."
            ExpectedToolNames = @("Bash", "bash")
            ExpectedMarker = ""
        },
        [ordered]@{
            Name = "filler-1"
            Prompt = "Do not use any tools. Reply with exactly FILLER_TURN_1 and nothing else."
            ExpectedToolNames = @()
            ExpectedMarker = "FILLER_TURN_1"
        },
        [ordered]@{
            Name = "filler-2"
            Prompt = "Do not use any tools. Reply with exactly FILLER_TURN_2 and nothing else."
            ExpectedToolNames = @()
            ExpectedMarker = "FILLER_TURN_2"
        },
        [ordered]@{
            Name = "filler-3"
            Prompt = "Do not use any tools. Reply with exactly FILLER_TURN_3 and nothing else."
            ExpectedToolNames = @()
            ExpectedMarker = "FILLER_TURN_3"
        },
        [ordered]@{
            Name = "compact"
            Prompt = $CompactPrompt
            ExpectedToolNames = @()
            ExpectedMarker = ""
        },
        [ordered]@{
            Name = "post-read"
            Prompt = "Use the Read tool again on tests/agent-capability/input.txt. Do not answer from memory. After the tool result, reply with exactly POST_COMPACT_READ_OK."
            ExpectedToolNames = @("Read", "read")
            ExpectedMarker = ""
        },
        [ordered]@{
            Name = "post-bash"
            Prompt = "Use the Bash tool exactly once. The command must create the local verification file .agent-probe/claude-post.txt containing exactly POST_COMPACT_BASH_OK, and it must also print exactly POST_COMPACT_BASH_STDOUT to stdout so the tool result is unambiguous. This is a local Chat2API probe artifact, not an external script. Do not call Bash a second time. After the tool result, reply with exactly POST_COMPACT_BASH_DONE."
            ExpectedToolNames = @("Bash", "bash")
            ExpectedMarker = ""
        },
        [ordered]@{
            Name = "final-confirm"
            Prompt = "The probe is complete. Do not use any tools. Reply with exactly CLAUDE_COMPACT_TOOL_CONTINUITY_OK and nothing else."
            ExpectedToolNames = @()
            ExpectedMarker = "CLAUDE_COMPACT_TOOL_CONTINUITY_OK"
        }
    )

    foreach ($turn in $turns) {
        $eventPath = Join-Path $runDir ("{0}.ndjson" -f $turn.Name)
        $stderrPath = Join-Path $runDir ("{0}.stderr.txt" -f $turn.Name)
        $script:CurrentTurnName = $turn.Name
        $script:CurrentEventPath = $eventPath
        $result = Invoke-ClaudeTurn `
            -Executable $claudeExecutable `
            -Prompt $turn.Prompt `
            -OutputPath $eventPath `
            -StderrPath $stderrPath `
            -ModelName $Model `
            -BaseUrl $AnthropicBaseUrl `
            -SessionId $sessionId `
            -ResumeBehavior $ResumeMode `
            -ExtraArgs $ClaudeArgs `
            -TimeoutSeconds $TurnTimeoutSeconds

        if ($result.TimedOut) {
            $timeoutRead = Read-NdjsonObjects $eventPath
            $timeoutEvents = if ($timeoutRead.Ok) { $timeoutRead.Events } else { $null }
            if ($timeoutEvents -and $turn.ExpectedToolNames.Count -gt 0) {
                $timeoutEvidence = Get-ClaudeToolEvidence $timeoutEvents $turn.ExpectedToolNames
                if ($timeoutEvidence.ToolUseSeen -and $timeoutEvidence.ToolResultSeen) {
                    Fail-Classified "post_tool_finalization_hang" "Claude turn '$($turn.Name)' timed out after successful tool completion. See $eventPath"
                }
            }
            if ($timeoutEvents -and (Test-ClaudeResultCompleted $timeoutEvents)) {
                Fail-Classified "claude_cli_hang_after_result" "Claude turn '$($turn.Name)' wrote a completed result event but the CLI process did not exit within ${TurnTimeoutSeconds}s. See $eventPath"
            }
            Fail-Classified "claude_turn_timeout" "Claude turn '$($turn.Name)' exceeded ${TurnTimeoutSeconds}s. See $eventPath"
        }

        if ($result.ExitCode -ne 0) {
            $crashRead = Read-NdjsonObjects $eventPath
            $crashEvents = if ($crashRead.Ok) { $crashRead.Events } else { $null }
            if (-not $crashRead.Ok -and $crashRead.FailureKind -eq "empty_event_stream") {
                Fail-Classified "empty_event_stream_before_first_turn" "Claude turn '$($turn.Name)' exited with code $($result.ExitCode) before writing any stream-json events. See $eventPath"
            }
            if ($crashEvents -and $turn.ExpectedToolNames.Count -gt 0) {
                $crashEvidence = Get-ClaudeToolEvidence $crashEvents $turn.ExpectedToolNames
                if ($crashEvidence.ToolUseSeen -and $crashEvidence.ToolResultSeen) {
                    Fail-Classified "post_tool_finalization_crash" "Claude turn '$($turn.Name)' exited with code $($result.ExitCode) after successful tool completion. See $eventPath"
                }
            }
            Fail-Classified "claude_turn_exit_nonzero" "Claude turn '$($turn.Name)' exited with code $($result.ExitCode). See $eventPath"
        }

        $rawText = [string]$result.CombinedOutput
        $rawToolLossNeedle = Get-ToolLossNeedle $rawText

        $detectedSessionId = Get-SessionIdFromText $rawText
        if (-not [string]::IsNullOrWhiteSpace($detectedSessionId)) {
            if (-not [string]::IsNullOrWhiteSpace($establishedSessionId) -and $detectedSessionId -ne $establishedSessionId) {
                Fail "Claude turn '$($turn.Name)' switched session ids from $establishedSessionId to $detectedSessionId"
            }
            $sessionId = $detectedSessionId
            $establishedSessionId = $detectedSessionId
        } elseif ($ResumeMode -eq "resume" -and [string]::IsNullOrWhiteSpace($establishedSessionId) -and $turn.Name -eq "pre-read") {
            Fail "Claude pre-read turn did not expose a session id. This probe needs a resumable Claude CLI session id to verify real compact continuity."
        }

        if ($turn.ExpectedMarker.Length -gt 0 -and $rawText.IndexOf($turn.ExpectedMarker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Fail "Claude turn '$($turn.Name)' did not emit expected marker $($turn.ExpectedMarker)"
        }

        $eventRead = Read-NdjsonObjects $eventPath
        if (-not $eventRead.Ok) {
            Fail-Classified $eventRead.FailureKind $eventRead.Message
        }
        $events = $eventRead.Events
        $eventText = ($events | ForEach-Object { ConvertTo-StableJson $_ }) -join [Environment]::NewLine
        $eventToolLossNeedle = Get-ToolLossNeedle $eventText

        $toolUseSeen = $false
        $toolResultSeen = $false
        if ($turn.ExpectedToolNames.Count -gt 0) {
            $toolEvidence = Get-ClaudeToolEvidence $events $turn.ExpectedToolNames
            $toolUseSeen = $toolEvidence.ToolUseSeen
            $toolResultSeen = $toolEvidence.ToolResultSeen
            if (-not $toolUseSeen) {
                Fail "Claude turn '$($turn.Name)' did not show a real tool_use event for [$($turn.ExpectedToolNames -join ', ')]"
            }
            if (-not $toolResultSeen) {
                Fail "Claude turn '$($turn.Name)' did not show a tool result/completion event for [$($turn.ExpectedToolNames -join ', ')]"
            }
        }

        $allowFalseSelfReport = ($turn.Name -eq "compact")
        if ($rawToolLossNeedle -and -not $allowFalseSelfReport) {
            Fail "$($turn.Name) contained forbidden tool-loss text: $rawToolLossNeedle"
        }
        if ($eventToolLossNeedle -and -not $allowFalseSelfReport) {
            Fail "$($turn.Name) events contained forbidden tool-loss text: $eventToolLossNeedle"
        }

        $turnSummaries.Add([ordered]@{
            name = $turn.Name
            sessionId = $sessionId
            expectedToolNames = $turn.ExpectedToolNames
            expectedMarker = $turn.ExpectedMarker
            toolUseSeen = $toolUseSeen
            toolResultSeen = $toolResultSeen
            rawToolLossNeedle = $rawToolLossNeedle
            eventToolLossNeedle = $eventToolLossNeedle
            eventPath = $eventPath
            stderrPath = $stderrPath
        }) | Out-Null
    }

    if (-not (Test-Path $preBashFile)) {
        Fail "Missing pre-compact Bash artifact $preBashFile"
    }
    if (-not (Test-Path $postBashFile)) {
        Fail "Missing post-compact Bash artifact $postBashFile"
    }
    if ((Get-Content -Raw $preBashFile).Trim() -ne "PRE_COMPACT_BASH_OK") {
        Fail "$preBashFile does not contain PRE_COMPACT_BASH_OK"
    }
    if ((Get-Content -Raw $postBashFile).Trim() -ne "POST_COMPACT_BASH_OK") {
        Fail "$postBashFile does not contain POST_COMPACT_BASH_OK"
    }
    Pass "Run $run created both pre/post compact Bash probe files"

    $newLogText = Get-AppendedLogText $LogPath $beforeLogLines
    if ([string]::IsNullOrWhiteSpace($newLogText)) {
        Fail "No new dev.log content captured during Claude compact probe run $run"
    }

    $catalogSourceNeedles = @(
        '"catalogSource":"current_request"',
        '"catalogSource":"session_catalog"',
        '"catalogSource":"prompt_embedded"',
        '"catalogSource":"restored_from_history"'
    )
    if (-not (Test-ContainsAny $newLogText $catalogSourceNeedles)) {
        Fail "dev.log append for run $run did not show a non-empty catalogSource"
    }
    if ($newLogText.IndexOf("claudeSessionKey", [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Fail "dev.log append for run $run did not show claudeSessionKey diagnostics"
    }
    if ($newLogText.IndexOf("anthropic_catalog_lost_after_compact", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Fail "dev.log append for run $run reported anthropic_catalog_lost_after_compact"
    }
    Pass "Run $run dev.log evidence shows Claude session diagnostics and a non-empty catalog source"

    $summary = [ordered]@{
        model = $Model
        run = $run
        sessionId = $sessionId
        logPath = $LogPath
        anthropicBaseUrl = $AnthropicBaseUrl
        turns = $turnSummaries
        devLogHasCatalogSource = $true
    }

    $summaryPath = Join-Path $runDir "result.json"
    Write-Utf8NoBomFile -Path $summaryPath -Text ($summary | ConvertTo-Json -Depth 100)
    $allRunSummaries.Add($summary) | Out-Null
    Pass "Run $run summary written to $summaryPath"
}

$aggregatePath = Join-Path $probeRoot "claude-compact-results.json"
Write-Utf8NoBomFile -Path $aggregatePath -Text ($allRunSummaries | ConvertTo-Json -Depth 100)

Write-ProbeStatusArtifact "passed" "All Claude compact continuity runs passed."
Write-Host "CLAUDE_COMPACT_TOOL_CONTINUITY_OK"
exit 0
