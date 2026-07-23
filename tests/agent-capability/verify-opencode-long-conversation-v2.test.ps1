param()

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
. (Join-Path $PSScriptRoot "verify-opencode-long-conversation-v2.helpers.ps1")

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message"
    exit 1
}

$actualEvent = '{"type":"tool_use","part":{"tool":"read","state":{"input":{"filePath":"src/renderer/src/App.tsx"}}}}' | ConvertFrom-Json
$actualPath = Get-OpenCodeReadFilePath $actualEvent
if ($actualPath -ne "src/renderer/src/App.tsx") {
    Fail "expected state.input.filePath, got '$actualPath'"
}

$legacyJsonEvent = '{"type":"tool_use","part":{"tool":"read","input":"{\"filePath\":\"src/renderer/src/index.css\"}"}}' | ConvertFrom-Json
$legacyJsonPath = Get-OpenCodeReadFilePath $legacyJsonEvent
if ($legacyJsonPath -ne "src/renderer/src/index.css") {
    Fail "expected legacy JSON part.input filePath, got '$legacyJsonPath'"
}

$legacyObjectEvent = '{"type":"tool_use","part":{"tool":"read","input":{"filePath":"tailwind.config.js"}}}' | ConvertFrom-Json
$legacyObjectPath = Get-OpenCodeReadFilePath $legacyObjectEvent
if ($legacyObjectPath -ne "tailwind.config.js") {
    Fail "expected legacy object part.input filePath, got '$legacyObjectPath'"
}

$badEvent = '{"type":"tool_use","part":{"tool":"read","state":{"input":{"path":"missing-filePath"}}}}' | ConvertFrom-Json
$threw = $false
try {
    Get-OpenCodeReadFilePath $badEvent | Out-Null
} catch {
    $threw = $true
    if ([string]$_ -notmatch "filePath") {
        Fail "expected filePath parse error, got $_"
    }
}
if (-not $threw) {
    Fail "expected malformed read input to throw"
}

function New-ToolUseEventLine([string]$Tool, [string]$FilePath) {
    $event = [ordered]@{
        type = "tool_use"
        part = [ordered]@{
            tool = $Tool
            state = [ordered]@{
                input = [ordered]@{
                    filePath = $FilePath
                }
            }
        }
    }
    return ($event | ConvertTo-Json -Compress -Depth 8)
}

$phaseAuditFixture = @(
    '{"type":"tool_use","part":{"tool":"skill","state":{"input":{"name":"white-ui-audit-probe"}}}}',
    (New-ToolUseEventLine "read" "tailwind.config.js"),
    (New-ToolUseEventLine "read" "src/renderer/src/index.css"),
    (New-ToolUseEventLine "glob" "src/renderer/src/components/**/*.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/settings/Settings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/session/SessionManagement.tsx"),
    (New-ToolUseEventLine "write" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/proxy/ProxySettings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/providers/Providers.tsx")
)
$phaseAudit = Get-OpenCodeLongProbePhaseReadAudit $phaseAuditFixture
if (-not $phaseAudit.NotesWriteSeen -or -not $phaseAudit.NotesRecoveryReadSeen) {
    Fail "phase read audit did not detect notes write and recovery read boundaries"
}
if (@($phaseAudit.Phase1Reads).Count -ne 2 -or @($phaseAudit.Phase2Reads).Count -ne 2) {
    Fail "phase read audit should count exactly 2 component reads in each phase, got phase1=$(@($phaseAudit.Phase1Reads).Count) phase2=$(@($phaseAudit.Phase2Reads).Count)"
}
if (-not (@($phaseAudit.Phase1Reads) -contains "src/renderer/src/components/settings/Settings.tsx") -or
    -not (@($phaseAudit.Phase1Reads) -contains "src/renderer/src/components/session/SessionManagement.tsx")) {
    Fail "phase read audit assigned wrong Phase 1 component files"
}
if (-not (@($phaseAudit.Phase2Reads) -contains "src/renderer/src/components/proxy/ProxySettings.tsx") -or
    -not (@($phaseAudit.Phase2Reads) -contains "src/renderer/src/components/providers/Providers.tsx")) {
    Fail "phase read audit assigned wrong Phase 2 component files"
}
if (@($phaseAudit.PhaseOverlap).Count -ne 0) {
    Fail "phase read audit reported overlap for distinct phase fixtures"
}

$missingRecoveryFixture = @(
    (New-ToolUseEventLine "read" "src/renderer/src/components/settings/Settings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/session/SessionManagement.tsx"),
    (New-ToolUseEventLine "write" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/proxy/ProxySettings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/providers/Providers.tsx")
)
$missingRecoveryAudit = Get-OpenCodeLongProbePhaseReadAudit $missingRecoveryFixture
if (-not $missingRecoveryAudit.NotesWriteSeen -or $missingRecoveryAudit.NotesRecoveryReadSeen) {
    Fail "phase read audit should require notes re-read as the Phase 2 boundary"
}
if (@($missingRecoveryAudit.Phase2Reads).Count -ne 0) {
    Fail "phase read audit must not count Phase 2 component reads before notes recovery read"
}

$overlapFixture = @(
    (New-ToolUseEventLine "read" "src/renderer/src/components/settings/Settings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/session/SessionManagement.tsx"),
    (New-ToolUseEventLine "write" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/settings/Settings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/providers/Providers.tsx")
)
$overlapAudit = Get-OpenCodeLongProbePhaseReadAudit $overlapFixture
if (@($overlapAudit.PhaseOverlap).Count -ne 1) {
    Fail "phase read audit should detect a Phase 2 re-read from Phase 1"
}

$deepSeekPhaseAuditFixture = @(
    '{"type":"tool_use","part":{"tool":"skill","state":{"input":{"name":"white-ui-audit-probe"}}}}',
    (New-ToolUseEventLine "read" "tailwind.config.js"),
    (New-ToolUseEventLine "read" "src/renderer/src/index.css"),
    (New-ToolUseEventLine "glob" "src/renderer/src/**/*.{tsx,css}"),
    (New-ToolUseEventLine "read" "src/renderer/src/pages/Settings.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/pages/SessionManagement.tsx"),
    (New-ToolUseEventLine "write" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" ".agent-probe/white-ui-notes.txt"),
    (New-ToolUseEventLine "read" "src/renderer/src/pages/Dashboard.tsx"),
    (New-ToolUseEventLine "read" "src/renderer/src/components/layout/Sidebar.tsx")
)
$deepSeekPhaseAudit = Get-OpenCodeLongProbePhaseReadAudit $deepSeekPhaseAuditFixture
if (@($deepSeekPhaseAudit.Phase1Reads).Count -ne 2 -or @($deepSeekPhaseAudit.Phase2Reads).Count -ne 2) {
    Fail "DeepSeek phase fixture should count exactly 2 component reads in each phase, got phase1=$(@($deepSeekPhaseAudit.Phase1Reads).Count) phase2=$(@($deepSeekPhaseAudit.Phase2Reads).Count)"
}
if (-not (@($deepSeekPhaseAudit.Phase1Reads) -contains "src/renderer/src/pages/Settings.tsx") -or
    -not (@($deepSeekPhaseAudit.Phase1Reads) -contains "src/renderer/src/pages/SessionManagement.tsx")) {
    Fail "DeepSeek phase fixture assigned wrong Phase 1 pages"
}
if (-not (@($deepSeekPhaseAudit.Phase2Reads) -contains "src/renderer/src/pages/Dashboard.tsx") -or
    -not (@($deepSeekPhaseAudit.Phase2Reads) -contains "src/renderer/src/components/layout/Sidebar.tsx")) {
    Fail "DeepSeek phase fixture assigned wrong Phase 2 files"
}
if (@($deepSeekPhaseAudit.PhaseOverlap).Count -ne 0) {
    Fail "DeepSeek phase fixture should not overlap Phase 1 and Phase 2"
}
foreach ($nonComponentPath in @(
    "src/renderer/src/index.css",
    "tailwind.config.js",
    "src/renderer/src/components/layout/sidebar.css",
    "src/renderer/src/pages/settings.json",
    ".agent-probe/white-ui-notes.txt"
)) {
    if (Test-WhiteUiComponentReadPath $nonComponentPath) {
        Fail "component read path filter accepted non-component resource: $nonComponentPath"
    }
}

$opencodeConfigRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chat2api-opencode-config-test-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $opencodeConfigRoot | Out-Null
try {
    $opencodeConfigPath = Join-Path $opencodeConfigRoot "opencode.json"
    $sentinelPath = Join-Path $opencodeConfigRoot "sentinel.json"
    $originalOpenCodeConfig = @'
{
  "provider": {
    "qwen": {
      "options": {
        "baseURL": "http://127.0.0.1:8081/v1",
        "apiKey": "qwen-key"
      }
    },
    "kimi": {
      "options": {
        "baseUrl": "http://127.0.0.1:8081/v1",
        "apiKey": "kimi-key"
      }
    },
    "external": {
      "options": {
        "baseURL": "https://example.invalid/v1",
        "apiKey": "external-key"
      }
    }
  },
  "untouched": {
    "baseURL": "http://127.0.0.1:9999/v1"
  }
}
'@
    [System.IO.File]::WriteAllText($opencodeConfigPath, $originalOpenCodeConfig, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($sentinelPath, '{"baseURL":"http://127.0.0.1:8081/v1"}', [System.Text.UTF8Encoding]::new($false))

    $snapshot = Set-OpenCodeLocalProviderBaseUrlsForProbe -ConfigPath $opencodeConfigPath -Port 48763
    if ([int]$snapshot.UpdatedCount -ne 2) {
        Fail "OpenCode config rewrite should update exactly two provider baseURL entries, got $($snapshot.UpdatedCount)"
    }
    $rewrittenConfig = Get-Content -Raw -LiteralPath $opencodeConfigPath | ConvertFrom-Json
    if ([string]$rewrittenConfig.provider.qwen.options.baseURL -ne "http://127.0.0.1:48763/v1") {
        Fail "OpenCode config rewrite did not align baseURL to probe port"
    }
    if ([string]$rewrittenConfig.provider.kimi.options.baseUrl -ne "http://127.0.0.1:48763/v1") {
        Fail "OpenCode config rewrite did not align baseUrl to probe port"
    }
    if ([string]$rewrittenConfig.provider.external.options.baseURL -ne "https://example.invalid/v1") {
        Fail "OpenCode config rewrite modified non-local provider baseURL"
    }
    if ([string]$rewrittenConfig.untouched.baseURL -ne "http://127.0.0.1:9999/v1") {
        Fail "OpenCode config rewrite modified non-provider local-looking fields"
    }
    if ((Get-Content -Raw -LiteralPath $sentinelPath) -ne '{"baseURL":"http://127.0.0.1:8081/v1"}') {
        Fail "OpenCode config rewrite touched a file other than the selected config path"
    }
    Restore-OpenCodeConfigSnapshot $snapshot
    if ((Get-Content -Raw -LiteralPath $opencodeConfigPath) -ne $originalOpenCodeConfig) {
        Fail "OpenCode config restore did not restore the exact original JSON"
    }

    $snapshotForFinally = $null
    try {
        $snapshotForFinally = Set-OpenCodeLocalProviderBaseUrlsForProbe -ConfigPath $opencodeConfigPath -Port 48764
        throw "simulated probe failure"
    } catch {
        # Simulate the verifier's failure path: restore must still happen.
    } finally {
        Restore-OpenCodeConfigSnapshot $snapshotForFinally
    }
    if ((Get-Content -Raw -LiteralPath $opencodeConfigPath) -ne $originalOpenCodeConfig) {
        Fail "OpenCode config restore did not run cleanly after simulated failure"
    }

    $missingConfigRejected = $false
    try {
        Resolve-OpenCodeConfigPath -ConfigPath (Join-Path $opencodeConfigRoot "missing-opencode.json") | Out-Null
    } catch {
        $missingConfigRejected = $true
        if ([string]$_ -notmatch "OpenCode config not found") {
            Fail "missing OpenCode config used unexpected error: $_"
        }
    }
    if (-not $missingConfigRejected) {
        Fail "missing OpenCode config was accepted"
    }

    $nonLocalPath = Join-Path $opencodeConfigRoot "non-local-opencode.json"
    [System.IO.File]::WriteAllText($nonLocalPath, '{"provider":{"remote":{"options":{"baseURL":"https://example.invalid/v1"}}}}', [System.Text.UTF8Encoding]::new($false))
    $nonLocalRejected = $false
    try {
        Set-OpenCodeLocalProviderBaseUrlsForProbe -ConfigPath $nonLocalPath -Port 48763 | Out-Null
    } catch {
        $nonLocalRejected = $true
        if ([string]$_ -notmatch "no local Chat2API provider") {
            Fail "non-local OpenCode config used unexpected error: $_"
        }
    }
    if (-not $nonLocalRejected) {
        Fail "OpenCode config without local provider baseURL was accepted"
    }

    $modelResolverPath = Join-Path $opencodeConfigRoot "model-resolver-opencode.json"
    [System.IO.File]::WriteAllText($modelResolverPath, @'
{
  "provider": {
    "chat2api": {
      "models": ["deepseek-v4-flash", "Kimi-K3"],
      "options": {
        "baseURL": "http://127.0.0.1:8081/v1"
      }
    },
    "qwen": {
      "models": ["Qwen3.7-Max"],
      "options": {
        "baseURL": "http://127.0.0.1:8081/v1"
      }
    }
  }
}
'@, [System.Text.UTF8Encoding]::new($false))
    $registeredModel = Resolve-OpenCodeRegisteredModelName -ConfigPath $modelResolverPath -RequestedModel "qwen/Qwen3.7-Max"
    if ($registeredModel -ne "qwen/Qwen3.7-Max") {
        Fail "registered provider/model should remain unchanged, got $registeredModel"
    }
    $remappedModel = Resolve-OpenCodeRegisteredModelName -ConfigPath $modelResolverPath -RequestedModel "deepseek/deepseek-v4-flash"
    if ($remappedModel -ne "chat2api/deepseek-v4-flash") {
        Fail "unregistered provider prefix should resolve by unique model id, got $remappedModel"
    }
    $bareModel = Resolve-OpenCodeRegisteredModelName -ConfigPath $modelResolverPath -RequestedModel "Kimi-K3"
    if ($bareModel -ne "chat2api/Kimi-K3") {
        Fail "bare model id should resolve by unique provider model registration, got $bareModel"
    }

    $ambiguousModelPath = Join-Path $opencodeConfigRoot "ambiguous-model-opencode.json"
    [System.IO.File]::WriteAllText($ambiguousModelPath, '{"provider":{"a":{"models":["same-model"]},"b":{"models":["same-model"]}}}', [System.Text.UTF8Encoding]::new($false))
    $ambiguousRejected = $false
    try {
        Resolve-OpenCodeRegisteredModelName -ConfigPath $ambiguousModelPath -RequestedModel "missing-provider/same-model" | Out-Null
    } catch {
        $ambiguousRejected = $true
        if ([string]$_ -notmatch "ambiguous") {
            Fail "ambiguous model resolver used unexpected error: $_"
        }
    }
    if (-not $ambiguousRejected) {
        Fail "ambiguous OpenCode model was accepted"
    }

    $missingModelRejected = $false
    try {
        Resolve-OpenCodeRegisteredModelName -ConfigPath $modelResolverPath -RequestedModel "deepseek/not-registered" | Out-Null
    } catch {
        $missingModelRejected = $true
        if ([string]$_ -notmatch "was not found") {
            Fail "missing model resolver used unexpected error: $_"
        }
    }
    if (-not $missingModelRejected) {
        Fail "missing OpenCode model was accepted"
    }

    $objectShapedModelPath = Join-Path $opencodeConfigRoot "object-shaped-models-opencode.json"
    [System.IO.File]::WriteAllText($objectShapedModelPath, @'
{
  "provider": {
    "chat2api": {
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash"
        },
        "Kimi-K3": {}
      },
      "options": {
        "baseURL": "http://127.0.0.1:8081/v1"
      }
    },
    "qwen": {
      "models": {
        "Qwen3.7-Max": {}
      }
    }
  }
}
'@, [System.Text.UTF8Encoding]::new($false))
    $objectRemappedModel = Resolve-OpenCodeRegisteredModelName -ConfigPath $objectShapedModelPath -RequestedModel "deepseek/deepseek-v4-flash"
    if ($objectRemappedModel -ne "chat2api/deepseek-v4-flash") {
        Fail "object-shaped OpenCode models should resolve by property name, got $objectRemappedModel"
    }
    $objectRegisteredModel = Resolve-OpenCodeRegisteredModelName -ConfigPath $objectShapedModelPath -RequestedModel "qwen/Qwen3.7-Max"
    if ($objectRegisteredModel -ne "qwen/Qwen3.7-Max") {
        Fail "object-shaped registered provider/model should remain unchanged, got $objectRegisteredModel"
    }
} finally {
    Remove-Item -LiteralPath $opencodeConfigRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$mainScriptPath = Join-Path $PSScriptRoot "verify-opencode-long-conversation-v2.ps1"
$mainScript = Get-Content -Raw $mainScriptPath
if ($mainScript -notmatch '\$previousStoreDir\s*=\s*\$env:CHAT2API_STORE_DIR') {
    Fail "main script must save previous CHAT2API_STORE_DIR before mutating the environment"
}
if ($mainScript -notmatch '\$contextConfigWasWritten\s*=\s*\$false' -or $mainScript -notmatch '\$contextConfigWasWritten\s*=\s*\$true') {
    Fail "main script must track whether aggressive context config was successfully written"
}
if ($mainScript -notmatch 'finally\s*\{[\s\S]*Stop-LoggedProcess\s+\$devServerHandle') {
    Fail "main script outer finally must stop the self-started dev server"
}
if ($mainScript -notmatch 'if\s*\(\$contextConfigWasWritten\s+-and\s+\$null\s+-ne\s+\$originalState\)') {
    Fail "main script must restore config only after successful config write"
}
if ($mainScript -notmatch '\$probeProxyPort\s*=\s*Get-ProviderBaseUrlPort\s+\$Model') {
    Fail "main script must derive readiness port from the OpenCode provider baseURL"
}
if ($mainScript -notmatch '\$opencodeModelName\s*=\s*Resolve-OpenCodeRegisteredModelName[\s\S]*-RequestedModel\s+\$Model' -or
    $mainScript -notmatch 'Invoke-ProviderPreflight\s+\$Model' -or
    $mainScript -notmatch 'Invoke-OpencodeRun[\s\S]*-ModelName\s+\$opencodeModelName') {
    Fail "main script must resolve OpenCode --model while keeping provider preflight on the original requested model"
}
if ($mainScript -notmatch 'Set-OpenCodeLocalProviderBaseUrlsForProbe[\s\S]*-Port\s+\$probeProxyPort' -or
    $mainScript -notmatch 'finally\s*\{[\s\S]*Restore-OpenCodeConfigSnapshot\s+\$opencodeConfigState') {
    Fail "main script must align OpenCode provider baseURL to probeProxyPort and restore it in finally"
}
if ($mainScript -notmatch 'config\.proxyPort\s*=\s*proxyPort' -or $mainScript -notmatch 'config\.autoStartProxy\s*=\s*true') {
    Fail "main script must write proxyPort and autoStartProxy before starting dev:win"
}
if ($mainScript -notmatch 'Wait-TcpEndpointReady\s+-HostName\s+"127\.0\.0\.1"\s+-Port\s+\$probeProxyPort') {
    Fail "main script must wait on the same probeProxyPort written to config"
}
if ($mainScript -match 'Wait-TcpEndpointReady\s+-HostName\s+"127\.0\.0\.1"\s+-Port\s+48763') {
    Fail "main script must not hardcode readiness wait to 48763"
}
if ($mainScript -notmatch 'config\.proxyPort\s*=\s*state\.proxyPort' -or $mainScript -notmatch 'config\.autoStartProxy\s*=\s*state\.autoStartProxy') {
    Fail "main script must restore proxyPort and autoStartProxy after probe"
}
if ($mainScript -notmatch 'Get-StructuredLogDeltaAudit\s+\$structuredLogSnapshots') {
    Fail "main script must collect structured log delta with source/runtime audit metadata"
}
if ($mainScript -notmatch 'Invoke-SessionReportAudit[\s\S]*-LogSourcePaths\s+\$structuredLogAudit\.SourcePaths[\s\S]*-RuntimeStructuredLogLineCount[\s\S]*-ProbeRunLockHandle\s+\$probeRunLockHandle') {
    Fail "main script must pass run log source paths, runtime count, and active lock into session report audit"
}
if ($mainScript -notmatch 'New-ProbeRunLogMarker\s+\$probeDir' -or $mainScript -notmatch 'Write-StructuredLogRunMarker[\s\S]*-Phase\s+"start"' -or $mainScript -notmatch 'Write-StructuredLogRunMarker[\s\S]*-Phase\s+"end"') {
    Fail "main script must write run-specific structured log start/end markers"
}
if ($mainScript -notmatch 'Acquire-ProbeRunStructuredLogLock[\s\S]*-ProbeDir\s+\$probeDir[\s\S]*-MarkerId\s+\$probeRunLogMarkerId' -or $mainScript -notmatch 'finally\s*\{[\s\S]*Release-ProbeRunStructuredLogLock\s+\$probeRunLockHandle') {
    Fail "main script must acquire and release a run-scoped structured log lock"
}
$skillMaterializationIndex = $mainScript.IndexOf('Set-ProbeRunSkillArtifactDirectory')
$skillLockAcquireIndex = $mainScript.IndexOf('Acquire-ProbeRunStructuredLogLock')
if ($skillMaterializationIndex -lt 0 -or $skillLockAcquireIndex -lt 0 -or $skillLockAcquireIndex -gt $skillMaterializationIndex) {
    Fail "main script must acquire the probe lock before materializing the active OpenCode skill"
}
if ($mainScript -notmatch '\$activeSkillPath\s*=\s*Join-Path\s+\(Resolve-Path\s+"\."\)\.Path\s+"\.opencode\\skills\\white-ui-audit-probe\\SKILL\.md"' -or $mainScript -notmatch 'Set-ProbeRunSkillArtifactDirectory\s+-SkillPath\s+\$activeSkillPath\s+-ProbeDir\s+\$probeDir') {
    Fail "main script must prepare the active OpenCode skill loaded from --dir . with the current run artifact directory"
}
if ($mainScript -notmatch '\$probeRootArtifactAuditCompleted\s*=\s*\$false' -or $mainScript -notmatch '\$probeRootArtifactAuditCompleted\s*=\s*\$true') {
    Fail "main script must track whether project-root artifact writes were audited"
}
if ($mainScript -notmatch 'catch\s*\{[\s\S]*Assert-NoProbeRootArtifactWrites\s+-Snapshots\s+\$probeRootArtifactSnapshots\s+-ProbeDir\s+\$probeDir[\s\S]*original_failure=') {
    Fail "main script failure path must audit and preserve evidence for project-root artifact writes"
}
if ($mainScript -notmatch 'finally\s*\{[\s\S]*Restore-ProbeRunSkillArtifactDirectory\s+\$probeRunSkillState') {
    Fail "main script must restore the active OpenCode skill after the run"
}
if ($mainScript -notmatch 'try\s*\{\s*Restore-ProbeRunSkillArtifactDirectory\s+\$probeRunSkillState[\s\S]*catch\s*\{[\s\S]*finally\s*\{\s*Release-ProbeRunStructuredLogLock\s+\$probeRunLockHandle') {
    Fail "main script must release the probe lock even when active skill restoration fails"
}
$helperScript = Get-Content -Raw (Join-Path $PSScriptRoot "verify-opencode-long-conversation-v2.helpers.ps1")
if ($helperScript -notmatch 'Invoke-TaskkillTreeBounded' -or $helperScript -notmatch 'TimeoutMilliseconds\s*=\s*5000' -or $helperScript -notmatch 'Kill\(\$true\)') {
    Fail "helper must use bounded taskkill tree cleanup with Kill(true) fallback"
}
if ($helperScript -match 'Get-CimInstance\s+Win32_Process\s+-Filter\s+"ParentProcessId') {
    Fail "helper must not query Win32_Process once per queued PID while building cleanup process trees"
}
if ($helperScript -notmatch 'function\s+Get-ProcessSnapshotForTree' -or $helperScript -notmatch 'Get-CimInstance\s+Win32_Process\s+-ErrorAction\s+Stop' -or $helperScript -notmatch '\$childrenByParent') {
    Fail "helper must build cleanup process trees from a single Win32_Process snapshot"
}
if ($helperScript -match 'RedirectStandardOutput\s+"NUL"' -or $helperScript -match 'RedirectStandardError\s+"NUL"') {
    Fail "helper must not redirect taskkill stdout/stderr to the same NUL target"
}
if ($helperScript -notmatch '\$stdoutPath\s*=\s*"\$redirectPrefix\.out"' -or
    $helperScript -notmatch '\$stderrPath\s*=\s*"\$redirectPrefix\.err"' -or
    $helperScript -notmatch 'RedirectStandardOutput\s+\$stdoutPath' -or
    $helperScript -notmatch 'RedirectStandardError\s+\$stderrPath' -or
    $helperScript -notmatch 'Remove-Item\s+-LiteralPath\s+\$stdoutPath' -or
    $helperScript -notmatch 'Remove-Item\s+-LiteralPath\s+\$stderrPath') {
    Fail "helper must use distinct bounded taskkill stdout/stderr temp files and remove them"
}
if ($helperScript -notmatch 'FileMode\]::CreateNew' -or $helperScript -notmatch 'FileShare\]::Read' -or $helperScript -notmatch 'probeRunDirectory' -or $helperScript -notmatch 'probeRunMarkerId') {
    Fail "helper must implement cross-process exclusive lock metadata for the current probe run"
}
if ($helperScript -notmatch 'function\s+Set-ProbeRunSkillArtifactDirectory' -or $helperScript -notmatch 'function\s+Restore-ProbeRunSkillArtifactDirectory' -or $helperScript -notmatch 'ConvertTo-ProbeRunSkill') {
    Fail "helper must support run-specific active OpenCode skill materialization and restore"
}
if ($helperScript -notmatch 'function\s+Invoke-ProviderPreflightWithRetry' -or $helperScript -notmatch 'Test-ProviderPreflightStartupRace' -or $helperScript -notmatch 'provider_preflight_startup_timeout') {
    Fail "helper must implement bounded provider preflight startup-race retry"
}

$preflightAttempts = 0
$preflightResult = Invoke-ProviderPreflightWithRetry `
    -Description "test/provider" `
    -StartupRetrySeconds 5 `
    -StartupRetryDelayMilliseconds 0 `
    -StartupRetryMaxAttempts 3 `
    -Request {
        $script:preflightAttempts++
        if ($script:preflightAttempts -eq 1) {
            throw "Response status code does not indicate success: 503 (Service Unavailable). no available account while provider is initializing"
        }
        return [pscustomobject]@{ ok = $true }
    }
if ($preflightAttempts -ne 2 -or $preflightResult.ok -ne $true) {
    Fail "provider preflight retry did not recover after one startup 503"
}

$persistentAttempts = 0
$persistentThrew = $false
try {
    Invoke-ProviderPreflightWithRetry `
        -Description "test/provider persistent" `
        -StartupRetrySeconds 5 `
        -StartupRetryDelayMilliseconds 0 `
        -StartupRetryMaxAttempts 3 `
        -Request {
            $script:persistentAttempts++
            throw "HTTP 503 service initializing: no available account"
        } | Out-Null
} catch {
    $persistentThrew = $true
    if ([string]$_ -notmatch "provider_preflight_startup_timeout" -or [string]$_ -notmatch "no available account") {
        Fail "persistent startup 503 used unexpected error: $_"
    }
}
if (-not $persistentThrew -or $persistentAttempts -ne 3) {
    Fail "provider preflight did not fail after bounded startup 503 retries"
}

foreach ($case in @(
    [pscustomobject]@{ Message = "Response status code does not indicate success: 401 (Unauthorized). token expired"; ExpectedAttempts = 1; Label = "401" },
    [pscustomobject]@{ Message = "Response status code does not indicate success: 403 (Forbidden). account disabled"; ExpectedAttempts = 1; Label = "403" },
    [pscustomobject]@{ Message = "Response status code does not indicate success: 404 (Not Found). provider endpoint missing"; ExpectedAttempts = 1; Label = "404" },
    [pscustomobject]@{ Message = "Response status code does not indicate success: 429 (Too Many Requests). rate limit"; ExpectedAttempts = 1; Label = "429" },
    [pscustomobject]@{ Message = "Unable to connect to the remote server"; ExpectedAttempts = 1; Label = "network" }
)) {
    $nonStartupAttempts = 0
    $nonStartupThrew = $false
    try {
        Invoke-ProviderPreflightWithRetry `
            -Description "test/provider $($case.Label)" `
            -StartupRetrySeconds 5 `
            -StartupRetryDelayMilliseconds 0 `
            -StartupRetryMaxAttempts 3 `
            -Request {
                $script:nonStartupAttempts++
                throw $case.Message
            } | Out-Null
    } catch {
        $nonStartupThrew = $true
        if ([string]$_ -match "provider_preflight_startup_timeout") {
            Fail "non-startup $($case.Label) error was converted into startup timeout"
        }
        if ([string]$_ -notlike "*$($case.Message)*") {
            Fail "non-startup $($case.Label) error was not propagated unchanged: $_"
        }
    }
    if (-not $nonStartupThrew -or $nonStartupAttempts -ne $case.ExpectedAttempts) {
        Fail "provider preflight retried non-startup $($case.Label) error"
    }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
try {
    $listener.Start()
    $readyPort = $listener.LocalEndpoint.Port
    $acceptTask = $listener.AcceptTcpClientAsync()
    if (-not (Wait-TcpEndpointReady -HostName "127.0.0.1" -Port $readyPort -TimeoutSeconds 2)) {
        Fail "Wait-TcpEndpointReady did not report ready listener"
    }
    try {
        if ($acceptTask.Wait(1000)) { $acceptTask.Result.Dispose() }
    } catch {}
} finally {
    $listener.Stop()
}

$closedListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
$closedListener.Start()
$closedPort = $closedListener.LocalEndpoint.Port
$closedListener.Stop()
$waitThrew = $false
try {
    Wait-TcpEndpointReady -HostName "127.0.0.1" -Port $closedPort -TimeoutSeconds 1 | Out-Null
} catch {
    $waitThrew = $true
    if ([string]$_ -notmatch "Timed out waiting") {
        Fail "Wait-TcpEndpointReady threw unexpected error: $_"
    }
}
if (-not $waitThrew) {
    Fail "Wait-TcpEndpointReady should throw for a closed endpoint"
}

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chat2api-v2-probe-test-" + [Guid]::NewGuid().ToString("N"))
$probeRoot = Join-Path $tmpRoot ".agent-probe"
$logPath = Join-Path $tmpRoot "dev.log"
try {
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $oldProbeLog = Join-Path $probeRoot "previous-dev-log-slice.log"
    [System.IO.File]::WriteAllText($oldProbeLog, "preserve-me", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($logPath, "preexisting" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    $runDir = New-ProbeRunDirectory $probeRoot
    if (-not (Test-Path $oldProbeLog)) {
        Fail "New-ProbeRunDirectory deleted existing probe log"
    }
    if ($runDir -eq $probeRoot -or -not $runDir.StartsWith((Resolve-Path $probeRoot).Path)) {
        Fail "New-ProbeRunDirectory did not create an isolated child run directory"
    }

    $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)
    if ($null -eq $pwsh) { $pwsh = Get-Command powershell.exe -ErrorAction Stop }
    $pwshPath = if (-not [string]::IsNullOrWhiteSpace([string]$pwsh.Source)) { [string]$pwsh.Source } else { [string]$pwsh.Path }
    $handle = Start-LoggedProcess `
        -FileName $pwshPath `
        -Arguments @("-NoProfile", "-Command", "Write-Output '{`"tag`":`"[ProviderRuntime] Context economy:`"}'; Write-Error 'stderr-sentinel'") `
        -LogPath $logPath `
        -WorkingDirectory $tmpRoot
    $handle.Process.WaitForExit(10000) | Out-Null
    Start-Sleep -Milliseconds 300
    Stop-LoggedProcess $handle

    $capturedLog = Get-Content -Raw $logPath
    if ($capturedLog -notmatch "preexisting") { Fail "Start-LoggedProcess overwrote existing LogPath content" }
    if ($capturedLog -notmatch "\[ProviderRuntime\] Context economy:") { Fail "Start-LoggedProcess did not capture stdout structured log" }
    if ($capturedLog -notmatch "stderr-sentinel") { Fail "Start-LoggedProcess did not capture stderr" }

    $fixedRootPrompt = @'
Write .agent-probe/white-ui-notes.txt.
Read .agent-probe\white-ui-decision.txt.
Write .agent-probe/white-ui-audit.md.
Keep ordinary text .agent-probe/not-a-probe-artifact.txt unchanged.
Keep similar text prefix.agent-probe/white-ui-notes.txt unchanged.
Keep ordinary bare filename white-ui-audit.md unchanged.
'@
    $projectProbeRoot = Join-Path (Resolve-Path ".").Path ".agent-probe"
    $fixedRootPrompt += [Environment]::NewLine + "Write $(Join-Path $projectProbeRoot "white-ui-notes.txt")."
    $fixedRootPrompt += [Environment]::NewLine + "Read $((Join-Path $projectProbeRoot "white-ui-decision.txt") -replace '\\', '/')."
    $fixedRootPrompt += [Environment]::NewLine + "Write $(Join-Path $projectProbeRoot "white-ui-audit.md")."
    $convertedPrompt = ConvertTo-ProbeRunPrompt -Prompt $fixedRootPrompt -ProbeDir $runDir
    $rootDir = Join-Path (Resolve-Path ".").Path ".agent-probe"
    $artifactCases = @(
        [pscustomobject]@{ Verb = "Write"; Name = "white-ui-notes.txt" },
        [pscustomobject]@{ Verb = "Read"; Name = "white-ui-decision.txt" },
        [pscustomobject]@{ Verb = "Write"; Name = "white-ui-audit.md" }
    )
    foreach ($case in $artifactCases) {
        $name = [string]$case.Name
        $verb = [string]$case.Verb
        $rootArtifact = Join-Path $rootDir $name
        if ($convertedPrompt.Contains($rootArtifact)) {
            Fail "prompt substitution still points at fixed root artifact $rootArtifact"
        }
        $runArtifact = Join-Path $runDir $name
        $runArtifactSlash = $runArtifact -replace '\\', '/'
        $rootArtifactSlash = $rootArtifact -replace '\\', '/'
        if ($convertedPrompt.Contains($rootArtifactSlash)) {
            Fail "prompt substitution still points at slash-normalized fixed root artifact $rootArtifactSlash"
        }
        $escapedVerb = [regex]::Escape($verb)
        $escapedRunArtifact = [regex]::Escape($runArtifact)
        $escapedRunArtifactSlash = [regex]::Escape($runArtifactSlash)
        if ($convertedPrompt -notmatch "$escapedVerb\s+(?:$escapedRunArtifact|$escapedRunArtifactSlash)\.") {
            Fail "prompt substitution did not rewrite $verb artifact token to run artifact $runArtifact"
        }
        $escapedName = [regex]::Escape($name)
        if ($convertedPrompt -match "$escapedVerb\s+\.agent-probe[\\/]+$escapedName\.") {
            Fail "prompt substitution left original $verb artifact token under .agent-probe for $name"
        }
    }
    if (-not $convertedPrompt.Contains(".agent-probe/not-a-probe-artifact.txt")) {
        Fail "prompt substitution changed ordinary non-artifact slash text"
    }
    if (-not $convertedPrompt.Contains("prefix.agent-probe/white-ui-notes.txt")) {
        Fail "prompt substitution changed similar non-artifact text"
    }
    if (-not $convertedPrompt.Contains("Keep ordinary bare filename white-ui-audit.md unchanged.")) {
        Fail "prompt substitution changed ordinary bare artifact filename text"
    }

    $slashRunDir = $runDir -replace '\\', '/'
    $slashOnlyPrompt = "Write .agent-probe/white-ui-notes.txt and .agent-probe/white-ui-audit.md."
    $slashOnlyConverted = ConvertTo-ProbeRunPrompt -Prompt $slashOnlyPrompt -ProbeDir $slashRunDir
    foreach ($name in @("white-ui-notes.txt", "white-ui-audit.md")) {
        $runArtifact = Join-Path $runDir $name
        $runArtifactSlash = $runArtifact -replace '\\', '/'
        $escapedRunArtifact = [regex]::Escape($runArtifact)
        $escapedRunArtifactSlash = [regex]::Escape($runArtifactSlash)
        if ($slashOnlyConverted -notmatch "(?:^|\s)(?:$escapedRunArtifact|$escapedRunArtifactSlash)(?:\.|\s)") {
            Fail "slash ProbeDir prompt substitution did not map slash artifact token to run artifact $runArtifact"
        }
        $escapedName = [regex]::Escape($name)
        if ($slashOnlyConverted -match "(?:^|\s)\.agent-probe[\\/]+$escapedName(?:\.|\s)") {
            Fail "slash ProbeDir prompt substitution left project-root artifact path for $name"
        }
    }

    $skillFixture = @'
---
name: white-ui-audit-probe
description: fixture
---
Write .agent-probe/white-ui-notes.txt.
Read .agent-probe\white-ui-decision.txt.
Write .agent-probe/white-ui-audit.md.
Keep .agent-probe/not-a-probe-artifact.txt unchanged.
Keep prefix.agent-probe/white-ui-notes.txt unchanged.
Keep ordinary bare filename white-ui-audit.md unchanged.
'@
    $skillFixture += [Environment]::NewLine + "Write $(Join-Path $projectProbeRoot "white-ui-notes.txt")."
    $skillFixture += [Environment]::NewLine + "Read $((Join-Path $projectProbeRoot "white-ui-decision.txt") -replace '\\', '/')."
    $skillFixture += [Environment]::NewLine + "Write $(Join-Path $projectProbeRoot "white-ui-audit.md")."
    $convertedSkill = ConvertTo-ProbeRunSkill -SkillContent $skillFixture -ProbeDir $runDir
    foreach ($name in @("white-ui-notes.txt", "white-ui-decision.txt", "white-ui-audit.md")) {
        $runArtifact = Join-Path $runDir $name
        $runArtifactSlash = $runArtifact -replace '\\', '/'
        $escapedRunArtifact = [regex]::Escape($runArtifact)
        $escapedRunArtifactSlash = [regex]::Escape($runArtifactSlash)
        if ($convertedSkill -notmatch "(?:^|\s)(?:$escapedRunArtifact|$escapedRunArtifactSlash)(?:\.|\s|`r|`n)") {
            Fail "skill substitution did not rewrite active skill artifact token to run artifact $runArtifact"
        }
        $escapedName = [regex]::Escape($name)
        if ($convertedSkill -match "(?:^|\s)\.agent-probe[\\/]+$escapedName(?:\.|\s|`r|`n)") {
            Fail "skill substitution left project-root active skill artifact path for $name"
        }
    }
    if (-not $convertedSkill.Contains(".agent-probe/not-a-probe-artifact.txt")) {
        Fail "skill substitution changed ordinary non-artifact slash text"
    }
    if (-not $convertedSkill.Contains("prefix.agent-probe/white-ui-notes.txt")) {
        Fail "skill substitution changed similar non-artifact text"
    }
    if (-not $convertedSkill.Contains("Keep ordinary bare filename white-ui-audit.md unchanged.")) {
        Fail "skill substitution changed ordinary bare artifact filename text"
    }

    $skillPath = Join-Path $tmpRoot "SKILL.md"
    [System.IO.File]::WriteAllText($skillPath, $skillFixture, [System.Text.UTF8Encoding]::new($false))
    $skillState = Set-ProbeRunSkillArtifactDirectory -SkillPath $skillPath -ProbeDir $runDir
    $activeSkill = Get-Content -Raw -LiteralPath $skillPath
    if ($activeSkill -match "(?:^|\s)\.agent-probe[\\/]+white-ui-(notes|decision|audit)\.(txt|md)(?:\.|\s|`r|`n)") {
        Fail "active skill materialization left a project-root artifact path"
    }
    if ($activeSkill -notmatch [regex]::Escape((Join-Path $runDir "white-ui-notes.txt"))) {
        Fail "active skill materialization did not include current run notes path"
    }
    Restore-ProbeRunSkillArtifactDirectory $skillState
    $restoredSkill = Get-Content -Raw -LiteralPath $skillPath
    if ($restoredSkill -ne $skillFixture) {
        Fail "active skill restore did not restore original content exactly"
    }

    $materializeFailurePath = Join-Path $tmpRoot "materialize-failure-SKILL.md"
    [System.IO.File]::WriteAllText($materializeFailurePath, $skillFixture, [System.Text.UTF8Encoding]::new($false))
    $materializeFailureOriginal = Get-Content -Raw -LiteralPath $materializeFailurePath
    $materializeFailed = $false
    try {
        Set-ProbeRunSkillArtifactDirectory -SkillPath $materializeFailurePath -ProbeDir (Join-Path $tmpRoot "missing-run-dir") | Out-Null
    } catch {
        $materializeFailed = $true
    } finally {
        if (Test-Path -LiteralPath $materializeFailurePath) {
            [System.IO.File]::WriteAllText($materializeFailurePath, $materializeFailureOriginal, [System.Text.UTF8Encoding]::new($false))
        }
    }
    if (-not $materializeFailed) {
        Fail "skill materialization failure fixture did not fail"
    }
    if ((Get-Content -Raw -LiteralPath $materializeFailurePath) -ne $materializeFailureOriginal) {
        Fail "original skill content was not restored after materialization failure"
    }

    $rootArtifactProbeRoot = Join-Path $tmpRoot ".agent-probe-root-artifact-audit"
    New-Item -ItemType Directory -Force -Path $rootArtifactProbeRoot | Out-Null
    $rootArtifactRunDir = New-ProbeRunDirectory $rootArtifactProbeRoot
    $rootArtifactSnapshots = Get-ProbeRootArtifactSnapshots $rootArtifactProbeRoot
    $rootArtifactPath = Join-Path $rootArtifactProbeRoot "white-ui-notes.txt"
    [System.IO.File]::WriteAllText($rootArtifactPath, "root write evidence", [System.Text.UTF8Encoding]::new($false))
    $rootArtifactRejected = $false
    try {
        Assert-NoProbeRootArtifactWrites -Snapshots $rootArtifactSnapshots -ProbeDir $rootArtifactRunDir
    } catch {
        $rootArtifactRejected = $true
        $rootArtifactMessage = [string]$_
        if ($rootArtifactMessage -notmatch "project_root_probe_artifact_written") {
            Fail "root artifact audit used unexpected rejection message: $rootArtifactMessage"
        }
    }
    if (-not $rootArtifactRejected) {
        Fail "root artifact audit accepted a project-root artifact write"
    }
    $rootArtifactEvidencePath = Join-Path $rootArtifactRunDir "project-root-artifact-evidence\white-ui-notes.txt"
    if (-not (Test-Path -LiteralPath $rootArtifactEvidencePath)) {
        Fail "root artifact audit did not copy project-root artifact evidence into the current run directory"
    }
    if ((Get-Content -Raw -LiteralPath $rootArtifactEvidencePath) -ne "root write evidence") {
        Fail "root artifact audit copied incorrect evidence content"
    }

    $storeDir = Join-Path $tmpRoot ".chat2api"
    $sources = Get-StructuredLogSourcePaths $storeDir
    foreach ($source in $sources) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
        [System.IO.File]::WriteAllText($source, "old-$([System.IO.Path]::GetFileName($source))" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    }

    $lockMarkerId = New-ProbeRunLogMarker $runDir
    $firstLock = Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $runDir -MarkerId $lockMarkerId -LogSourcePaths $sources
    try {
        if (-not (Test-Path -LiteralPath $firstLock.LockPath)) {
            Fail "probe run structured log lock file was not created"
        }
        $lockMetadata = Get-Content -Raw -LiteralPath $firstLock.LockPath | ConvertFrom-Json
        if ([string]$lockMetadata.probeRunDirectory -ne (Resolve-Path -LiteralPath $runDir).Path) {
            Fail "probe run structured log lock did not record current run directory"
        }
        if ([string]$lockMetadata.probeRunMarkerId -ne $lockMarkerId) {
            Fail "probe run structured log lock did not record current marker id"
        }
        if (@($lockMetadata.logSourcePaths).Count -ne 2) {
            Fail "probe run structured log lock did not record structured log source paths"
        }
        $secondRunDir = New-ProbeRunDirectory $probeRoot
        $forgedLockHandle = [pscustomobject]@{
            LockPath = $firstLock.LockPath
            Stream = $null
            ProbeRunDirectory = $secondRunDir
            ProbeRunMarkerId = "probe-run-forged"
        }
        Release-ProbeRunStructuredLogLock $forgedLockHandle
        if (-not (Test-Path -LiteralPath $firstLock.LockPath)) {
            Fail "probe run structured log lock release removed a lock owned by another run"
        }
        $secondRejected = $false
        try {
            Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $secondRunDir -MarkerId (New-ProbeRunLogMarker $secondRunDir) -LogSourcePaths $sources | Out-Null
        } catch {
            $secondRejected = $true
            if ([string]$_ -notmatch "probe_run_lock_unavailable") {
                Fail "occupied probe run lock used unexpected rejection message: $_"
            }
        }
        if (-not $secondRejected) {
            Fail "second run acquired the same structured log lock while first run was active"
        }
    } finally {
        Release-ProbeRunStructuredLogLock $firstLock
    }
    if (Test-Path -LiteralPath $firstLock.LockPath) {
        Fail "probe run structured log lock was not removed after release"
    }
    $releasedLock = Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $runDir -MarkerId (New-ProbeRunLogMarker $runDir) -LogSourcePaths $sources
    Release-ProbeRunStructuredLogLock $releasedLock

    $lockFailurePath = Join-Path $tmpRoot "lock-failure-SKILL.md"
    [System.IO.File]::WriteAllText($lockFailurePath, $skillFixture, [System.Text.UTF8Encoding]::new($false))
    $lockFailureState = Set-ProbeRunSkillArtifactDirectory -SkillPath $lockFailurePath -ProbeDir $runDir
    $lockFailureOriginal = [string]$lockFailureState.OriginalContent
    $blockingLock = Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $runDir -MarkerId (New-ProbeRunLogMarker $runDir) -LogSourcePaths $sources
    $lockFailure = $false
    try {
        Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $secondRunDir -MarkerId (New-ProbeRunLogMarker $secondRunDir) -LogSourcePaths $sources | Out-Null
    } catch {
        $lockFailure = $true
    } finally {
        Restore-ProbeRunSkillArtifactDirectory $lockFailureState
        Release-ProbeRunStructuredLogLock $blockingLock
    }
    if (-not $lockFailure) {
        Fail "lock failure fixture did not fail"
    }
    if ((Get-Content -Raw -LiteralPath $lockFailurePath) -ne $lockFailureOriginal) {
        Fail "original skill content was not restored after lock failure"
    }

    $snapshots = Get-LogLineSnapshots $sources
    $markerId = New-ProbeRunLogMarker $runDir
    Write-StructuredLogRunMarker -Paths $sources -ProbeDir $runDir -MarkerId $markerId -Phase "start"
    [System.IO.File]::AppendAllText($sources[0], '{"tag":"[ProviderRuntime] Context economy:","msg":"app-new"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::AppendAllText($sources[1], '{"tag":"[Forwarder] Runtime pilot request trace:","msg":"request-new"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-StructuredLogRunMarker -Paths $sources -ProbeDir $runDir -MarkerId $markerId -Phase "end"
    $delta = Get-StructuredLogDeltaText $snapshots
    if ($delta -match "old-") { Fail "structured log delta included historical lines" }
    if ($delta -notmatch "app-new" -or $delta -notmatch "request-new") { Fail "structured log delta missed app/request new lines" }

    $runLogAudit = Get-StructuredLogDeltaAudit $snapshots $runDir $markerId
    if ($runLogAudit.Text -match "old-") { Fail "structured log audit included historical lines" }
    if ($runLogAudit.Text -notmatch "app-new" -or $runLogAudit.Text -notmatch "request-new") { Fail "structured log audit missed same-run structured lines" }
    if ([int]$runLogAudit.RuntimeStructuredLogLineCount -lt 2) { Fail "structured log audit did not count same-run runtime records" }
    if (@($runLogAudit.SourcePaths).Count -ne 2) { Fail "structured log audit did not preserve actual same-run source paths" }
    if ([string]$runLogAudit.ProbeRunMarkerId -ne $markerId) { Fail "structured log audit did not preserve current run marker id" }
    if ([int]$runLogAudit.ProbeRunStartMarkerCount -lt 2 -or [int]$runLogAudit.ProbeRunEndMarkerCount -lt 2) {
        Fail "structured log audit did not observe current run start/end markers from source logs"
    }

    $reportPath = Join-Path $runDir "session-report-fixture.json"
    [System.IO.File]::WriteAllText(
        $reportPath,
        '{"sessions":[{"id":1}],"sessionCount":1,"issues":[]}',
        [System.Text.UTF8Encoding]::new($false)
    )
    $metadataWithoutLockRejected = $false
    try {
        Update-SessionReportRunMetadata `
            -ReportPath $reportPath `
            -ProbeDir $runDir `
            -LogSourcePaths @($runLogAudit.SourcePaths) `
            -RuntimeStructuredLogLineCount ([int]$runLogAudit.RuntimeStructuredLogLineCount) `
            -ProbeRunMarkerId ([string]$runLogAudit.ProbeRunMarkerId) `
            -ProbeRunStartMarkerCount ([int]$runLogAudit.ProbeRunStartMarkerCount) `
            -ProbeRunEndMarkerCount ([int]$runLogAudit.ProbeRunEndMarkerCount) | Out-Null
    } catch {
        $metadataWithoutLockRejected = $true
        if ([string]$_ -notmatch "active probe run structured log lock") {
            Fail "session report metadata without lock used unexpected rejection message: $_"
        }
    }
    if (-not $metadataWithoutLockRejected) {
        Fail "session report metadata accepted run markers without an active structured log lock"
    }

    $metadataLock = Acquire-ProbeRunStructuredLogLock -StoreDir $storeDir -ProbeDir $runDir -MarkerId ([string]$runLogAudit.ProbeRunMarkerId) -LogSourcePaths $sources
    try {
        Update-SessionReportRunMetadata `
            -ReportPath $reportPath `
            -ProbeDir $runDir `
            -LogSourcePaths @($runLogAudit.SourcePaths) `
            -RuntimeStructuredLogLineCount ([int]$runLogAudit.RuntimeStructuredLogLineCount) `
            -ProbeRunMarkerId "probe-run-wrong-marker" `
            -ProbeRunStartMarkerCount ([int]$runLogAudit.ProbeRunStartMarkerCount) `
            -ProbeRunEndMarkerCount ([int]$runLogAudit.ProbeRunEndMarkerCount) `
            -ProbeRunLockHandle $metadataLock | Out-Null
        Fail "session report metadata accepted a lock with mismatched marker"
    } catch {
        if ([string]$_ -notmatch "lock marker mismatch") {
            Fail "session report metadata lock marker rejection used unexpected message: $_"
        }
    }

    try {
        Update-SessionReportRunMetadata `
            -ReportPath $reportPath `
            -ProbeDir $runDir `
            -LogSourcePaths @($runLogAudit.SourcePaths) `
            -RuntimeStructuredLogLineCount ([int]$runLogAudit.RuntimeStructuredLogLineCount) `
            -ProbeRunMarkerId ([string]$runLogAudit.ProbeRunMarkerId) `
            -ProbeRunStartMarkerCount ([int]$runLogAudit.ProbeRunStartMarkerCount) `
            -ProbeRunEndMarkerCount ([int]$runLogAudit.ProbeRunEndMarkerCount) `
            -ProbeRunLockHandle $metadataLock | Out-Null
    } finally {
        Release-ProbeRunStructuredLogLock $metadataLock
    }
    $reportJson = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    if ([string]$reportJson.probeRunDirectory -ne (Resolve-Path -LiteralPath $runDir).Path) {
        Fail "session report metadata did not record current run directory"
    }
    if ([string]$reportJson.probeRunMarkerId -ne $markerId) {
        Fail "session report metadata did not record current run marker id"
    }
    if (@($reportJson.logSourcePaths).Count -ne 2) {
        Fail "session report metadata did not record actual log source paths"
    }
    if ([int]$reportJson.runtimeStructuredLogLineCount -lt 2) {
        Fail "session report metadata did not record runtime structured log count"
    }
    if ([int]$reportJson.probeRunStartMarkerCount -lt 2 -or [int]$reportJson.probeRunEndMarkerCount -lt 2) {
        Fail "session report metadata did not record run marker counts"
    }
    if ([string]$reportJson.structuredLogLockMarkerId -ne $markerId) {
        Fail "session report metadata did not record active lock marker"
    }
    if ([string]$reportJson.structuredLogLockProbeRunDirectory -ne (Resolve-Path -LiteralPath $runDir).Path) {
        Fail "session report metadata did not record active lock run directory"
    }
    if ([string]::IsNullOrWhiteSpace([string]$reportJson.structuredLogLockPath) -or -not ([string]$reportJson.structuredLogLockPath).EndsWith("opencode-long-conversation-v2.structured-log.lock")) {
        Fail "session report metadata did not record active lock path"
    }
    if (@($reportJson.structuredLogLockSourcePaths).Count -ne 2) {
        Fail "session report metadata did not record active lock source coverage"
    }

    $startupOnlySource = Join-Path $storeDir "logs\startup-only.ndjson"
    [System.IO.File]::WriteAllText($startupOnlySource, "vite ready" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $startupSnapshots = Get-LogLineSnapshots @($startupOnlySource)
    Write-StructuredLogRunMarker -Paths @($startupOnlySource) -ProbeDir $runDir -MarkerId $markerId -Phase "start"
    [System.IO.File]::AppendAllText($startupOnlySource, "electron-vite dev server ready" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-StructuredLogRunMarker -Paths @($startupOnlySource) -ProbeDir $runDir -MarkerId $markerId -Phase "end"
    $startupAudit = Get-StructuredLogDeltaAudit $startupSnapshots $runDir $markerId
    if ([int]$startupAudit.RuntimeStructuredLogLineCount -ne 0) {
        Fail "startup-only log should not satisfy runtime structured log audit"
    }
    $metadataRejectedStartupOnly = $false
    try {
        Update-SessionReportRunMetadata `
            -ReportPath $reportPath `
            -ProbeDir $runDir `
            -LogSourcePaths @($startupAudit.SourcePaths) `
            -RuntimeStructuredLogLineCount ([int]$startupAudit.RuntimeStructuredLogLineCount) `
            -ProbeRunMarkerId ([string]$startupAudit.ProbeRunMarkerId) `
            -ProbeRunStartMarkerCount ([int]$startupAudit.ProbeRunStartMarkerCount) `
            -ProbeRunEndMarkerCount ([int]$startupAudit.ProbeRunEndMarkerCount) `
            -ProbeRunLockHandle $null | Out-Null
    } catch {
        $metadataRejectedStartupOnly = $true
        if ([string]$_ -notmatch "runtime structured log") {
            Fail "startup-only metadata rejection used unexpected message: $_"
        }
    }
    if (-not $metadataRejectedStartupOnly) { Fail "session report metadata accepted startup-only logs" }

    $oldOnlySnapshots = Get-LogLineSnapshots $sources
    $oldOnlyAudit = Get-StructuredLogDeltaAudit $oldOnlySnapshots $runDir $markerId
    if (-not [string]::IsNullOrWhiteSpace([string]$oldOnlyAudit.Text)) {
        Fail "structured log audit misread old log lines as current run delta"
    }

    $otherRunDir = New-ProbeRunDirectory $probeRoot
    $otherRunSource = Join-Path $storeDir "logs\other-run.ndjson"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $otherRunSource) | Out-Null
    [System.IO.File]::WriteAllText($otherRunSource, "", [System.Text.UTF8Encoding]::new($false))
    $otherRunSnapshots = Get-LogLineSnapshots @($otherRunSource)
    $otherMarkerId = New-ProbeRunLogMarker $otherRunDir
    Write-StructuredLogRunMarker -Paths @($otherRunSource) -ProbeDir $otherRunDir -MarkerId $otherMarkerId -Phase "start"
    [System.IO.File]::AppendAllText($otherRunSource, '{"tag":"[ProviderRuntime] Context economy:","msg":"other-run-runtime"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-StructuredLogRunMarker -Paths @($otherRunSource) -ProbeDir $otherRunDir -MarkerId $otherMarkerId -Phase "end"
    $otherRunAudit = Get-StructuredLogDeltaAudit $otherRunSnapshots $runDir $markerId
    if (-not [string]::IsNullOrWhiteSpace([string]$otherRunAudit.Text) -or [int]$otherRunAudit.RuntimeStructuredLogLineCount -ne 0) {
        Fail "structured log audit accepted another run's marked runtime records"
    }

    $sameNamePollutionSource = $sources[0]
    $sameNameSnapshots = Get-LogLineSnapshots @($sameNamePollutionSource)
    [System.IO.File]::AppendAllText($sameNamePollutionSource, '{"tag":"[ProviderRuntime] Context economy:","msg":"same-name-before-marker"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-StructuredLogRunMarker -Paths @($sameNamePollutionSource) -ProbeDir $runDir -MarkerId $markerId -Phase "start"
    [System.IO.File]::AppendAllText($sameNamePollutionSource, '{"tag":"[ProviderRuntime] Context economy:","msg":"same-name-current-run"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-StructuredLogRunMarker -Paths @($sameNamePollutionSource) -ProbeDir $runDir -MarkerId $markerId -Phase "end"
    [System.IO.File]::AppendAllText($sameNamePollutionSource, '{"tag":"[ProviderRuntime] Context economy:","msg":"same-name-after-marker"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $sameNameAudit = Get-StructuredLogDeltaAudit $sameNameSnapshots $runDir $markerId
    if ($sameNameAudit.Text -match "same-name-before-marker" -or $sameNameAudit.Text -match "same-name-after-marker") {
        Fail "structured log audit accepted same-name log pollution outside current run markers"
    }
    if ($sameNameAudit.Text -notmatch "same-name-current-run" -or [int]$sameNameAudit.RuntimeStructuredLogLineCount -ne 1) {
        Fail "structured log audit failed to keep same-name current run record"
    }

    $emptySource = Join-Path $storeDir "request-logs\empty-run.ndjson"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $emptySource) | Out-Null
    [System.IO.File]::WriteAllText($emptySource, "", [System.Text.UTF8Encoding]::new($false))
    $emptySnapshots = Get-LogLineSnapshots @($emptySource)
    Write-StructuredLogRunMarker -Paths @($emptySource) -ProbeDir $runDir -MarkerId $markerId -Phase "start"
    Write-StructuredLogRunMarker -Paths @($emptySource) -ProbeDir $runDir -MarkerId $markerId -Phase "end"
    $emptyAudit = Get-StructuredLogDeltaAudit $emptySnapshots $runDir $markerId
    if (-not [string]::IsNullOrWhiteSpace([string]$emptyAudit.Text) -or [int]$emptyAudit.RuntimeStructuredLogLineCount -ne 0) {
        Fail "empty current run log should not produce runtime audit text"
    }
    $metadataRejectedEmpty = $false
    try {
        Update-SessionReportRunMetadata `
            -ReportPath $reportPath `
            -ProbeDir $runDir `
            -LogSourcePaths @($emptyAudit.SourcePaths) `
            -RuntimeStructuredLogLineCount ([int]$emptyAudit.RuntimeStructuredLogLineCount) `
            -ProbeRunMarkerId ([string]$emptyAudit.ProbeRunMarkerId) `
            -ProbeRunStartMarkerCount ([int]$emptyAudit.ProbeRunStartMarkerCount) `
            -ProbeRunEndMarkerCount ([int]$emptyAudit.ProbeRunEndMarkerCount) `
            -ProbeRunLockHandle $null | Out-Null
    } catch {
        $metadataRejectedEmpty = $true
        if ([string]$_ -notmatch "runtime structured log") {
            Fail "empty metadata rejection used unexpected message: $_"
        }
    }
    if (-not $metadataRejectedEmpty) { Fail "session report metadata accepted empty run logs" }

    [System.IO.File]::WriteAllText($logPath, "preexisting-child" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $childCommand = @'
$child = Start-Process -FilePath '__PWSH__' -ArgumentList @('-NoProfile','-Command','Write-Output ''[ProviderRuntime] Context economy: child-structured-log''; Write-Error ''child-stderr-sentinel''') -NoNewWindow -PassThru
$child.WaitForExit()
exit $child.ExitCode
'@.Replace("__PWSH__", $pwshPath.Replace("'", "''"))
    $childHandle = Start-LoggedProcess `
        -FileName $pwshPath `
        -Arguments @("-NoProfile", "-Command", $childCommand) `
        -LogPath $logPath `
        -WorkingDirectory $tmpRoot
    $childHandle.Process.WaitForExit(10000) | Out-Null
    Start-Sleep -Milliseconds 300
    Stop-LoggedProcess $childHandle

    $childCapturedLog = Get-Content -Raw $logPath
    if ($childCapturedLog -notmatch "preexisting-child") { Fail "Start-LoggedProcess overwrote LogPath before child process capture" }
    if ($childCapturedLog -notmatch "child-structured-log") { Fail "Start-LoggedProcess did not capture inherited child stdout structured log" }
    if ($childCapturedLog -notmatch "child-stderr-sentinel") { Fail "Start-LoggedProcess did not capture inherited child stderr" }

    $originalSnapshotForTree = (Get-Command Get-ProcessSnapshotForTree -CommandType Function).ScriptBlock
    try {
        $snapshotCalls = 0
        Set-Item -Path function:\Get-ProcessSnapshotForTree -Value {
            $script:snapshotCalls++
            return @(
                [pscustomobject]@{ ProcessId = 6002; ParentProcessId = 6001 },
                [pscustomobject]@{ ProcessId = 6003; ParentProcessId = 6002 },
                [pscustomobject]@{ ProcessId = 6004; ParentProcessId = 6002 },
                [pscustomobject]@{ ProcessId = 6005; ParentProcessId = 6004 },
                [pscustomobject]@{ ProcessId = 7001; ParentProcessId = 7000 }
            )
        }
        $treeFixture = @(Get-LoggedProcessTreePids 6001 | Sort-Object)
        $expectedTreeFixture = @(6001, 6002, 6003, 6004, 6005)
        if (($treeFixture -join ",") -ne ($expectedTreeFixture -join ",")) {
            Fail "Get-LoggedProcessTreePids did not traverse the snapshot-built process tree: got [$($treeFixture -join ',')]"
        }
        if ($snapshotCalls -ne 1) {
            Fail "Get-LoggedProcessTreePids should take exactly one process snapshot, got $snapshotCalls"
        }
    } finally {
        Set-Item -Path function:\Get-ProcessSnapshotForTree -Value $originalSnapshotForTree
    }

    $exitedHandle = Start-LoggedProcess `
        -FileName $pwshPath `
        -Arguments @("-NoProfile", "-Command", "exit 0") `
        -LogPath $logPath `
        -WorkingDirectory $tmpRoot
    $exitedHandle.Process.WaitForExit(10000) | Out-Null
    Stop-LoggedProcess $exitedHandle

    $originalTaskkill = (Get-Command Invoke-TaskkillTreeBounded -CommandType Function).ScriptBlock
    $originalTree = (Get-Command Get-LoggedProcessTreePids -CommandType Function).ScriptBlock
    $originalStopById = (Get-Command Stop-LoggedProcessByIdBounded -CommandType Function).ScriptBlock
    $originalIsRunning = (Get-Command Test-ProcessIsRunning -CommandType Function).ScriptBlock
    try {
        $fakePid = 424242
        $fakeProcess = [pscustomobject]@{ Id = $fakePid; HasExited = $false; Disposed = $false }
        $fakeProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
        $fakeProcess | Add-Member -MemberType ScriptMethod -Name Kill -Value { param($entireTree) throw [System.ComponentModel.Win32Exception]::new(5, "Access denied") }
        $fakeProcess | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
        Set-Item -Path function:\Invoke-TaskkillTreeBounded -Value { param([int]$ProcessId, [int]$TimeoutMilliseconds = 5000) return $false }
        Set-Item -Path function:\Get-LoggedProcessTreePids -Value { param([int]$RootProcessId) return @($RootProcessId, 424243) }
        Set-Item -Path function:\Stop-LoggedProcessByIdBounded -Value { param([int]$ProcessId, [int]$TimeoutMilliseconds = 5000) throw [System.ComponentModel.Win32Exception]::new(5, "Access denied") }
        Set-Item -Path function:\Test-ProcessIsRunning -Value { param([int]$ProcessId) return ($ProcessId -eq 424242 -or $ProcessId -eq 424243) }

        $refused = $false
        try {
            Stop-LoggedProcess ([pscustomobject]@{ Process = $fakeProcess; WrapperPath = $null })
        } catch {
            $refused = $true
            $message = [string]$_
            if ($message -notmatch "survivors=\[424243,424242\]" -or $message -notmatch "Access denied" -or $message -notmatch "tree=\[424243,424242\]") {
                Fail "Stop-LoggedProcess root-refuses failure did not preserve bounded tree evidence: $message"
            }
        }
        if (-not $refused) { Fail "Stop-LoggedProcess accepted a still-running access-denied tree" }
        if (-not $fakeProcess.Disposed) { Fail "Stop-LoggedProcess did not dispose failed fake process handle" }
    } finally {
        Set-Item -Path function:\Invoke-TaskkillTreeBounded -Value $originalTaskkill
        Set-Item -Path function:\Get-LoggedProcessTreePids -Value $originalTree
        Set-Item -Path function:\Stop-LoggedProcessByIdBounded -Value $originalStopById
        Set-Item -Path function:\Test-ProcessIsRunning -Value $originalIsRunning
    }

    if ($PSVersionTable.PSVersion.Major -ge 6) {
        [System.IO.File]::WriteAllText($logPath, "bounded-cleanup" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        $treeCommand = "Start-Sleep -Seconds 60"
        $treeHandle = Start-LoggedProcess `
            -FileName $pwshPath `
            -Arguments @("-NoProfile", "-Command", $treeCommand) `
            -LogPath $logPath `
            -WorkingDirectory $tmpRoot
        Start-Sleep -Milliseconds 500
        $rootPid = [int]$treeHandle.Process.Id
        if (-not (Test-ProcessIsRunning $rootPid)) { Fail "bounded cleanup test process was not running before Stop-LoggedProcess" }
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        Stop-LoggedProcess $treeHandle
        $stopwatch.Stop()
        if ($stopwatch.Elapsed.TotalSeconds -gt 15) {
            Fail "Stop-LoggedProcess took too long: $($stopwatch.Elapsed.TotalSeconds)s"
        }
        if (Test-ProcessIsRunning $rootPid) {
            try { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue } catch {}
            Fail "Stop-LoggedProcess did not terminate process root"
        }
    }
} finally {
    if (Test-Path $tmpRoot) {
        for ($i = 0; $i -lt 10 -and (Test-Path $tmpRoot); $i++) {
            try {
                Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction Stop
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if (Test-Path $tmpRoot) {
            Write-Host "[WARN] Failed to remove temporary test directory: $tmpRoot"
        }
    }
}

Write-Host "[PASS] verify-opencode-long-conversation-v2 read input parser regression passed"
