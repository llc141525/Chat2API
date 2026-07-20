function Get-OpenCodeReadFilePath($Event) {
    if ($null -eq $Event -or $Event.type -ne "tool_use" -or [string]$Event.part.tool -ne "read") {
        return ""
    }

    $inputValue = $Event.part.state.input
    if ($null -eq $inputValue) {
        $inputValue = $Event.part.input
    }
    if ($null -eq $inputValue) {
        throw "read tool event is missing part.state.input and part.input"
    }

    if ($inputValue -is [string]) {
        if ([string]::IsNullOrWhiteSpace($inputValue)) {
            throw "read tool input is empty"
        }
        try {
            $inputValue = $inputValue | ConvertFrom-Json
        } catch {
            throw "read tool input is not valid JSON: $($_.Exception.Message)"
        }
    }

    $filePath = [string]$inputValue.filePath
    if ([string]::IsNullOrWhiteSpace($filePath)) {
        throw "read tool input is missing filePath"
    }
    return $filePath
}

function New-ProbeRunDirectory([string]$ProbeRoot) {
    if ([string]::IsNullOrWhiteSpace($ProbeRoot)) {
        throw "ProbeRoot is required"
    }
    New-Item -ItemType Directory -Force -Path $ProbeRoot | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $runDir = Join-Path $ProbeRoot ("run-$stamp-$PID")
    New-Item -ItemType Directory -Force -Path $runDir | Out-Null
    return (Resolve-Path $runDir).Path
}

function ConvertTo-ProbeRunPrompt([string]$Prompt, [string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedProbeDir = (Resolve-Path $ProbeDir).Path
    $slashDir = $resolvedProbeDir -replace '\\', '/'
    $backslashDir = $resolvedProbeDir -replace '/', '\'
    $converted = [string]$Prompt
    $converted = $converted.Replace('.agent-probe/', "$slashDir/")
    $converted = $converted.Replace('.agent-probe\', "$backslashDir\")
    $override = @"

## Probe artifact directory override
For this run, every artifact path under `.agent-probe/` or `.agent-probe\` from the `white-ui-audit-probe` skill MUST be written to this run-specific absolute directory instead:

`$resolvedProbeDir`

Use these exact artifact paths:
- `$resolvedProbeDir\white-ui-notes.txt`
- `$resolvedProbeDir\white-ui-decision.txt`
- `$resolvedProbeDir\white-ui-audit.md`

Do not read from or write to the project-root `.agent-probe` artifact paths for this run.
"@
    return $converted + $override
}

function Get-StructuredLogSourcePaths([string]$StoreDir) {
    if ([string]::IsNullOrWhiteSpace($StoreDir)) { throw "StoreDir is required" }
    return @(
        (Join-Path $StoreDir "logs\app-logs.ndjson"),
        (Join-Path $StoreDir "request-logs\request-logs.ndjson")
    )
}

function Get-LogLineSnapshots([string[]]$Paths) {
    return @($Paths | ForEach-Object {
        $path = [string]$_
        $count = 0
        if (Test-Path $path) {
            $count = @(Get-Content -LiteralPath $path).Count
        }
        [pscustomobject]@{ Path = $path; LineCount = $count }
    })
}

function Get-StructuredLogDeltaText($Snapshots) {
    $chunks = New-Object System.Collections.Generic.List[string]
    foreach ($snapshot in @($Snapshots)) {
        $path = [string]$snapshot.Path
        $before = [int]$snapshot.LineCount
        if (-not (Test-Path $path)) { continue }
        $lines = @(Get-Content -LiteralPath $path)
        if ($lines.Count -le $before) { continue }
        $delta = @($lines | Select-Object -Skip $before | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        foreach ($line in $delta) { $chunks.Add([string]$line) }
    }
    return ($chunks -join [Environment]::NewLine)
}

function Join-ProcessArgumentString([string[]]$Arguments) {
    return ($Arguments | ForEach-Object {
        $arg = [string]$_
        if ($arg.Length -eq 0) { return '""' }
        if ($arg -match '[\s"]') {
            $escaped = $arg -replace '(\\*)"', '$1$1\"'
            $escaped = $escaped -replace '(\\+)$', '$1$1'
            return '"' + $escaped + '"'
        }
        return $arg
    }) -join ' '
}

function Add-ProcessArguments([System.Diagnostics.ProcessStartInfo]$StartInfo, [string[]]$Arguments) {
    if ($null -ne $StartInfo.ArgumentList) {
        foreach ($arg in $Arguments) { $StartInfo.ArgumentList.Add($arg) | Out-Null }
        return
    }
    $StartInfo.Arguments = Join-ProcessArgumentString $Arguments
}

function Resolve-PowerShellExe {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -eq $pwsh) { $pwsh = Get-Command powershell.exe -ErrorAction Stop }
    $path = if (-not [string]::IsNullOrWhiteSpace([string]$pwsh.Source)) { [string]$pwsh.Source } else { [string]$pwsh.Path }
    if ([string]::IsNullOrWhiteSpace($path)) { $path = [string]$pwsh.Definition }
    if ([string]::IsNullOrWhiteSpace($path)) { throw "Cannot resolve PowerShell executable for logged process wrapper" }
    return $path
}

function Resolve-CommandPath($Command) {
    if ($null -eq $Command) { return "" }
    foreach ($propertyName in @("Source", "Path", "Definition")) {
        $value = [string]$Command.$propertyName
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
    }
    return ""
}

function Wait-TcpEndpointReady {
    param(
        [string]$HostName = "127.0.0.1",
        [int]$Port = 48763,
        [int]$TimeoutSeconds = 60
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = ""
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connectTask = $client.ConnectAsync($HostName, $Port)
            if ($connectTask.Wait(1000) -and $client.Connected) {
                return $true
            }
            $lastError = "connect_timeout"
        } catch {
            $lastError = $_.Exception.Message
        } finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $HostName`:$Port to accept TCP connections within $TimeoutSeconds seconds. Last error: $lastError"
}

function Test-ProcessIsRunning([int]$ProcessId) {
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return $null -ne $proc
    } catch {
        return $false
    }
}

function Wait-ProcessExitWithin([System.Diagnostics.Process]$Process, [int]$TimeoutMilliseconds) {
    if ($null -eq $Process) { return $true }
    try { return $Process.WaitForExit($TimeoutMilliseconds) } catch { return $true }
}

function Invoke-TaskkillTreeBounded([int]$ProcessId, [int]$TimeoutMilliseconds = 5000) {
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($null -eq $taskkill) { return $false }
    $taskkillPath = Resolve-CommandPath $taskkill
    if ([string]::IsNullOrWhiteSpace($taskkillPath)) { return $false }

    $taskkillProcess = Start-Process -FilePath $taskkillPath -ArgumentList @("/PID", [string]$ProcessId, "/T", "/F") -NoNewWindow -PassThru
    if (-not $taskkillProcess.WaitForExit($TimeoutMilliseconds)) {
        try { $taskkillProcess.Kill() } catch {}
        try { $taskkillProcess.Dispose() } catch {}
        return $false
    }
    try { $taskkillProcess.Dispose() } catch {}
    return $true
}

function Start-LoggedProcess {
    param(
        [Parameter(Mandatory=$true)][string]$FileName,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory=$true)][string]$LogPath,
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $resolvedLogPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogPath)
    $logDir = Split-Path -Parent $resolvedLogPath
    if (-not [string]::IsNullOrWhiteSpace($logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    if (-not (Test-Path $resolvedLogPath)) {
        [System.IO.File]::WriteAllText($resolvedLogPath, "", [System.Text.UTF8Encoding]::new($false))
    }

    # Use a wrapper-level file redirection instead of .NET async output events.
    # electron-vite starts an Electron child process; on Windows the child's
    # structured stdout/stderr is most reliable when the whole process tree
    # inherits the same PowerShell redirection target.
    $wrapperDir = if ([string]::IsNullOrWhiteSpace($logDir)) { [System.IO.Path]::GetTempPath() } else { $logDir }
    $wrapperPath = Join-Path $wrapperDir (".chat2api-probe-logged-{0}-{1}.ps1" -f $PID, [Guid]::NewGuid().ToString("N"))
    $wrapperScript = @'
param(
    [Parameter(Mandatory=$true)][string]$TargetFile,
    [string]$TargetArgsJson = "[]",
    [Parameter(Mandatory=$true)][string]$TargetWorkingDirectory,
    [Parameter(Mandatory=$true)][string]$TargetLogPath
)
$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $TargetWorkingDirectory
$targetArgs = @()
if (-not [string]::IsNullOrWhiteSpace($TargetArgsJson)) {
    $parsedArgs = ConvertFrom-Json -InputObject $TargetArgsJson
    if ($null -ne $parsedArgs) { $targetArgs = @($parsedArgs | ForEach-Object { [string]$_ }) }
}
& $TargetFile @targetArgs *>> $TargetLogPath
exit $LASTEXITCODE
'@
    [System.IO.File]::WriteAllText($wrapperPath, $wrapperScript, [System.Text.UTF8Encoding]::new($false))

    $targetArgsJson = ConvertTo-Json -Compress -Depth 20 @($Arguments)

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Resolve-PowerShellExe
    Add-ProcessArguments $psi @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $wrapperPath,
        "-TargetFile",
        $FileName,
        "-TargetArgsJson",
        $targetArgsJson,
        "-TargetWorkingDirectory",
        $WorkingDirectory,
        "-TargetLogPath",
        $resolvedLogPath
    )
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $process.EnableRaisingEvents = $true

    try {
        $process.Start() | Out-Null
    } catch {
        Remove-Item -LiteralPath $wrapperPath -Force -ErrorAction SilentlyContinue
        $process.Dispose()
        throw
    }

    return [pscustomobject]@{
        Process = $process
        LogPath = $resolvedLogPath
        WrapperPath = $wrapperPath
        OwnsProcess = $true
    }
}

function Stop-LoggedProcess($Handle) {
    if ($null -eq $Handle) { return }
    try {
        if ($Handle.Process -and -not $Handle.Process.HasExited) {
            $pidToKill = [int]$Handle.Process.Id
            $killed = $false
            if ($IsWindows -or $env:OS -eq "Windows_NT") {
                $killed = Invoke-TaskkillTreeBounded -ProcessId $pidToKill -TimeoutMilliseconds 5000
            }
            if (-not $killed) {
                try { $Handle.Process.Kill($true) } catch { $Handle.Process.Kill() }
            }
            Wait-ProcessExitWithin -Process $Handle.Process -TimeoutMilliseconds 5000 | Out-Null
            if (Test-ProcessIsRunning $pidToKill) {
                throw "logged process tree root PID $pidToKill is still running after Stop-LoggedProcess"
            }
        }
    } finally {
        if ($Handle.Process) { $Handle.Process.Dispose() }
        if ($Handle.WrapperPath) { Remove-Item -LiteralPath $Handle.WrapperPath -Force -ErrorAction SilentlyContinue }
    }
}
