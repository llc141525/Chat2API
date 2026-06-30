param(
    [Parameter(Mandatory=$true)]
    [string]$Model
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    Write-Host "CAPABILITY_PROBE_FAIL"
    exit 1
}

function Pass([string]$Message) {
    Write-Host "[PASS] $Message"
}

function Get-LineValue([string]$Text, [string]$Key) {
    $escaped = [regex]::Escape($Key)
    $match = [regex]::Match($Text, "(?m)^$escaped=(.*)$")
    if (-not $match.Success) {
        Fail "Missing key in input file: $Key"
    }
    return $match.Groups[1].Value
}

function ConvertTo-StableJson($Value) {
    return $Value | ConvertTo-Json -Compress -Depth 20
}

function Get-EventText($Event) {
    return ConvertTo-StableJson $Event
}

function Test-ContainsAny([string]$Text, [string[]]$Needles) {
    foreach ($needle in $Needles) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Invoke-OpenCodeDebug([string[]]$Args, [string]$OutputPath) {
    $output = & opencode @Args 2>&1
    $exit = $LASTEXITCODE
    $output | Out-File -FilePath $OutputPath -Encoding utf8
    if ($exit -ne 0) {
        Fail "opencode $($Args -join ' ') failed with code $exit"
    }
    return ($output -join "`n")
}

Write-Host "============================================"
Write-Host " Chat2API Final Agent Capability Probe"
Write-Host " Model: $Model"
Write-Host "============================================"

$probeDir = ".agent-probe"
if (Test-Path $probeDir) {
    Remove-Item -Recurse -Force $probeDir
}
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null

$inputPath = "tests/agent-capability/input.txt"
$promptPath = "tests/agent-capability/prompt.md"
$eventsPath = "$probeDir/opencode-events.ndjson"
$resultPath = "$probeDir/result.json"
$skillDebugPath = "$probeDir/opencode-debug-skill.json"
$agentDebugPath = "$probeDir/opencode-debug-agent.json"

if (-not (Test-Path $inputPath)) { Fail "Input file not found: $inputPath" }
if (-not (Test-Path $promptPath)) { Fail "Prompt file not found: $promptPath" }
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { Fail "opencode command not found in PATH" }

$skillDebug = Invoke-OpenCodeDebug @("debug", "skill") $skillDebugPath
if ($skillDebug.IndexOf('"name": "agent-capability-probe"', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Fail "agent-capability-probe is not visible in opencode debug skill"
}
Pass "agent-capability-probe is visible in opencode debug skill"

$agentDebug = Invoke-OpenCodeDebug @("debug", "agent", "capability-probe") $agentDebugPath
if ($agentDebug.IndexOf('"skill": true', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Fail "capability-probe agent does not expose the skill tool"
}
Pass "capability-probe agent exposes the skill tool"

$inputResolved = Resolve-Path $inputPath
$inputBytes = [System.IO.File]::ReadAllBytes($inputResolved)
$inputText = [System.IO.File]::ReadAllText($inputResolved, [System.Text.Encoding]::UTF8)
$expectedSha256 = (Get-FileHash -Path $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedByteLength = $inputBytes.Length
$expectedLineCount = ([regex]::Matches($inputText, "`r`n|`n|`r").Count)
if ($inputText.Length -gt 0) { $expectedLineCount += 1 }

$expected = [ordered]@{
    skill = "agent-capability-probe"
    inputSha256 = $expectedSha256
    byteLength = $expectedByteLength
    lineCount = $expectedLineCount
    angleText = Get-LineValue $inputText "angle_text"
    fakeXml = Get-LineValue $inputText "fake_xml"
    chat2apiMarker = Get-LineValue $inputText "chat2api_marker"
}

$prompt = Get-Content -Raw $promptPath

Write-Host "Running OpenCode..."
$rawOutput = & opencode run --model $Model --agent capability-probe --format json --dir . $prompt 2>&1
$exitCode = $LASTEXITCODE
$rawOutput | Out-File -FilePath $eventsPath -Encoding utf8

if ($exitCode -ne 0) {
    Fail "opencode exited with code $exitCode"
}
Pass "OpenCode exited successfully"

if (-not (Test-Path $resultPath)) {
    Fail "Missing $resultPath"
}
Pass "$resultPath exists"

try {
    $actualJson = Get-Content -Raw $resultPath | ConvertFrom-Json
} catch {
    Fail "Failed to parse result.json: $_"
}

$actual = [ordered]@{
    skill = [string]$actualJson.skill
    inputSha256 = [string]$actualJson.inputSha256
    byteLength = [int]$actualJson.byteLength
    lineCount = [int]$actualJson.lineCount
    angleText = [string]$actualJson.angleText
    fakeXml = [string]$actualJson.fakeXml
    chat2apiMarker = [string]$actualJson.chat2apiMarker
}

$expectedJson = ConvertTo-StableJson $expected
$actualStableJson = ConvertTo-StableJson $actual
if ($actualStableJson -ne $expectedJson) {
    Write-Host "Expected: $expectedJson"
    Write-Host "Actual  : $actualStableJson"
    Fail "result.json does not match deterministic expected values"
}
Pass "result.json exactly matches deterministic expected values"

$eventLines = Get-Content $eventsPath | Where-Object { $_.Trim().Length -gt 0 }
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

$skillCallSeen = $false
$nonSkillToolCallCount = 0
$toolResultSeen = $false
$nonSkillToolAfterResultSeen = $false
$finalDoneSeen = $false

$skillNeedles = @("agent-capability-probe", '"skill"')
$toolCallNeedles = @("tool_call", "toolcall", "tool_call_delta", "call_tool", "tool.start", "tool.starting", "tool:call", "function_call")
$toolResultNeedles = @("tool_result", "toolresult", "observation", "tool.finish", "tool.finished", "tool:result")
$nonSkillToolNames = @("read", "bash", "grep", "glob", "list", "edit", "write", "read_file", "Get-Content", "Get-FileHash")

foreach ($event in $events) {
    $text = Get-EventText $event

    if ($text.Contains("CAPABILITY_PROBE_DONE")) {
        $finalDoneSeen = $true
    }

    if ((Test-ContainsAny $text $skillNeedles) -and (Test-ContainsAny $text $toolCallNeedles)) {
        $skillCallSeen = $true
    }

    $looksLikeToolCall = Test-ContainsAny $text $toolCallNeedles
    $looksLikeToolResult = Test-ContainsAny $text $toolResultNeedles
    $looksLikeNonSkillTool = (Test-ContainsAny $text $nonSkillToolNames) -and -not ($text.Contains("agent-capability-probe") -and $text.Contains('"skill"'))

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
    Fail "No real skill tool call for agent-capability-probe found in OpenCode events"
}
Pass "Skill invocation found in OpenCode events"

if ($nonSkillToolCallCount -lt 2) {
    Fail "Expected at least 2 non-skill tool calls, found $nonSkillToolCallCount"
}
Pass "At least 2 non-skill tool calls found"

if (-not $nonSkillToolAfterResultSeen) {
    Fail "No non-skill tool call found after a tool result/observation event; multi-turn tool use was not proven"
}
Pass "Multi-turn non-skill tool use proven by event order"

if (-not $finalDoneSeen) {
    Fail "Final assistant output did not contain CAPABILITY_PROBE_DONE"
}
Pass "Final completion marker found"

Write-Host "CAPABILITY_PROBE_PASS"
exit 0
