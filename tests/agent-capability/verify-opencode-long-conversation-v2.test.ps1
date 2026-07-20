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
$helperScript = Get-Content -Raw (Join-Path $PSScriptRoot "verify-opencode-long-conversation-v2.helpers.ps1")
if ($helperScript -notmatch 'Invoke-TaskkillTreeBounded' -or $helperScript -notmatch 'TimeoutMilliseconds\s*=\s*5000' -or $helperScript -notmatch 'Kill\(\$true\)') {
    Fail "helper must use bounded taskkill tree cleanup with Kill(true) fallback"
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
'@
    $convertedPrompt = ConvertTo-ProbeRunPrompt -Prompt $fixedRootPrompt -ProbeDir $runDir
    $rootDir = Join-Path (Resolve-Path ".").Path ".agent-probe"
    foreach ($name in @("white-ui-notes.txt", "white-ui-decision.txt", "white-ui-audit.md")) {
        $rootArtifact = Join-Path $rootDir $name
        if ($convertedPrompt.Contains($rootArtifact)) {
            Fail "prompt substitution still points at fixed root artifact $rootArtifact"
        }
        $runArtifact = Join-Path $runDir $name
        if (-not $convertedPrompt.Contains($runArtifact)) {
            Fail "prompt substitution did not include run artifact $runArtifact"
        }
    }

    $storeDir = Join-Path $tmpRoot ".chat2api"
    $sources = Get-StructuredLogSourcePaths $storeDir
    foreach ($source in $sources) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
        [System.IO.File]::WriteAllText($source, "old-$([System.IO.Path]::GetFileName($source))" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    }
    $snapshots = Get-LogLineSnapshots $sources
    [System.IO.File]::AppendAllText($sources[0], '{"tag":"[ProviderRuntime] Context economy:","msg":"app-new"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::AppendAllText($sources[1], '{"tag":"[Forwarder] Runtime pilot request trace:","msg":"request-new"}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $delta = Get-StructuredLogDeltaText $snapshots
    if ($delta -match "old-") { Fail "structured log delta included historical lines" }
    if ($delta -notmatch "app-new" -or $delta -notmatch "request-new") { Fail "structured log delta missed app/request new lines" }

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
