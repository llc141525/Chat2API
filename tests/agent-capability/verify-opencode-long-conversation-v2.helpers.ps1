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

function Get-OpenCodeToolInputValue($Event) {
    if ($null -eq $Event -or $Event.type -ne "tool_use") {
        return $null
    }

    $inputValue = $Event.part.state.input
    if ($null -eq $inputValue) {
        $inputValue = $Event.part.input
    }
    if ($inputValue -is [string]) {
        if ([string]::IsNullOrWhiteSpace($inputValue)) {
            return $null
        }
        try {
            return ($inputValue | ConvertFrom-Json)
        } catch {
            return $null
        }
    }
    return $inputValue
}

function Get-OpenCodeToolFilePath($Event) {
    $inputValue = Get-OpenCodeToolInputValue $Event
    if ($null -eq $inputValue) {
        return ""
    }

    $filePath = [string]$inputValue.filePath
    if ([string]::IsNullOrWhiteSpace($filePath)) {
        $filePath = [string]$inputValue.path
    }
    return $filePath
}

function Test-OpenCodeToolName([string]$ToolName, [string]$Expected) {
    if ([string]::IsNullOrWhiteSpace($ToolName) -or [string]::IsNullOrWhiteSpace($Expected)) {
        return $false
    }
    $normalizedTool = $ToolName.ToLowerInvariant()
    $normalizedExpected = $Expected.ToLowerInvariant()
    if ($normalizedTool -eq $normalizedExpected) {
        return $true
    }
    if ($normalizedExpected -eq "read") {
        return ($normalizedTool -match '(^|[:_.-])read(_file)?$')
    }
    if ($normalizedExpected -eq "write") {
        return ($normalizedTool -match '(^|[:_.-])write(_file)?$')
    }
    return $false
}

function Test-WhiteUiNotesPath([string]$FilePath) {
    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        return $false
    }
    $normalized = $FilePath -replace '\\', '/'
    return $normalized.EndsWith('/white-ui-notes.txt') -or $normalized -eq 'white-ui-notes.txt'
}

function Test-WhiteUiComponentReadPath([string]$FilePath) {
    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        return $false
    }
    $normalized = ($FilePath -replace '\\', '/').ToLowerInvariant()
    if ($normalized -match '(^|/)(tailwind\.config\.(js|ts)|index\.css)$') {
        return $false
    }
    if ($normalized -match '(^|/)white-ui-(notes|decision)\.txt$' -or $normalized -match '(^|/)white-ui-audit\.md$') {
        return $false
    }
    return ($normalized -match '(^|/)src/renderer/src/(pages|components)/.+\.(tsx|jsx)$')
}

function Get-OpenCodeLongProbePhaseReadAudit([string[]]$EventLines) {
    $phase1Reads = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $phase2Reads = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $state = "collect_phase1"
    $notesWriteSeen = $false
    $notesRecoveryReadSeen = $false

    foreach ($line in $EventLines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $evt = $line | ConvertFrom-Json
        } catch {
            throw "Invalid NDJSON during phase read check: $($line.Substring(0, [Math]::Min(80, $line.Length)))"
        }
        if ($evt.type -ne "tool_use") {
            continue
        }

        $toolName = [string]$evt.part.tool
        $filePath = Get-OpenCodeToolFilePath $evt

        if ((Test-OpenCodeToolName $toolName "write") -and (Test-WhiteUiNotesPath $filePath)) {
            $notesWriteSeen = $true
            if ($state -eq "collect_phase1") {
                $state = "wait_notes_reread"
            }
            continue
        }

        if (-not (Test-OpenCodeToolName $toolName "read")) {
            continue
        }

        if ((Test-WhiteUiNotesPath $filePath) -and $state -eq "wait_notes_reread") {
            $notesRecoveryReadSeen = $true
            $state = "collect_phase2"
            continue
        }

        if (-not (Test-WhiteUiComponentReadPath $filePath)) {
            continue
        }

        if ($state -eq "collect_phase1") {
            $phase1Reads.Add($filePath) | Out-Null
        } elseif ($state -eq "collect_phase2") {
            $phase2Reads.Add($filePath) | Out-Null
        }
    }

    $overlap = @()
    foreach ($filePath in $phase2Reads) {
        if ($phase1Reads.Contains($filePath)) {
            $overlap += $filePath
        }
    }

    return [pscustomobject]@{
        Phase1Reads = @($phase1Reads)
        Phase2Reads = @($phase2Reads)
        NotesWriteSeen = $notesWriteSeen
        NotesRecoveryReadSeen = $notesRecoveryReadSeen
        PhaseOverlap = $overlap
    }
}

function Resolve-OpenCodeConfigPath {
    param(
        [string]$ConfigPath = ""
    )

    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        if (-not (Test-Path -LiteralPath $ConfigPath)) {
            throw "OpenCode config not found: $ConfigPath"
        }
        return (Resolve-Path -LiteralPath $ConfigPath).Path
    }

    $candidates = @(
        (Join-Path $HOME ".config\opencode\opencode.json"),
        (Join-Path $HOME ".config\opencode\opencode.jsonc"),
        ".\opencode.json",
        ".\opencode.jsonc"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "OpenCode config not found. Expected one of: $($candidates -join ', ')"
}

function Test-LocalChat2ApiBaseUrl([string]$BaseUrl) {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        return $false
    }
    return ($BaseUrl -match '^https?://(127\.0\.0\.1|localhost):\d+/v1/?$')
}

function Get-OpenCodeConfigProperty($Object, [string]$Name) {
    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }
    foreach ($property in @($Object.PSObject.Properties)) {
        if ([string]$property.Name -ceq $Name) {
            return $property
        }
    }
    return $null
}

function Set-OpenCodeLocalProviderBaseUrlsForProbe {
    param(
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        [Parameter(Mandatory=$true)][int]$Port
    )

    if ($Port -lt 1 -or $Port -gt 65535) {
        throw "Probe proxy port is invalid: $Port"
    }
    $resolvedConfigPath = Resolve-OpenCodeConfigPath -ConfigPath $ConfigPath
    $originalContent = Get-Content -Raw -LiteralPath $resolvedConfigPath
    try {
        $config = $originalContent | ConvertFrom-Json
    } catch {
        throw "Failed to parse OpenCode config $resolvedConfigPath : $($_.Exception.Message)"
    }

    $replacementBaseUrl = "http://127.0.0.1:$Port/v1"
    $updatedCount = 0
    $providerRootProperty = Get-OpenCodeConfigProperty $config "provider"
    $providerRoot = if ($null -ne $providerRootProperty) { $providerRootProperty.Value } else { $null }
    if ($null -ne $providerRoot) {
        foreach ($providerProperty in @($providerRoot.PSObject.Properties)) {
            $providerConfig = $providerProperty.Value
            if ($null -eq $providerConfig) { continue }
            $containers = @($providerConfig)
            $optionsProperty = Get-OpenCodeConfigProperty $providerConfig "options"
            if ($null -ne $optionsProperty) { $containers += $optionsProperty.Value }
            foreach ($container in $containers) {
                foreach ($propertyName in @("baseURL", "baseUrl")) {
                    $property = Get-OpenCodeConfigProperty $container $propertyName
                    if ($null -eq $property) { continue }
                    $baseUrl = [string]$property.Value
                    if (-not (Test-LocalChat2ApiBaseUrl $baseUrl)) { continue }
                    if ($baseUrl -ne $replacementBaseUrl) {
                        $property.Value = $replacementBaseUrl
                    }
                    $updatedCount++
                }
            }
        }
    }

    if ($updatedCount -lt 1) {
        throw "OpenCode config has no local Chat2API provider baseURL/baseUrl entries to align: $resolvedConfigPath"
    }

    $updatedJson = $config | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($resolvedConfigPath, $updatedJson, [System.Text.UTF8Encoding]::new($false))
    return [pscustomobject]@{
        ConfigPath = $resolvedConfigPath
        OriginalContent = $originalContent
        UpdatedCount = $updatedCount
        ReplacementBaseUrl = $replacementBaseUrl
    }
}

function Restore-OpenCodeConfigSnapshot($Snapshot) {
    if ($null -eq $Snapshot) { return }
    $configPath = [string]$Snapshot.ConfigPath
    if ([string]::IsNullOrWhiteSpace($configPath)) { return }
    [System.IO.File]::WriteAllText($configPath, [string]$Snapshot.OriginalContent, [System.Text.UTF8Encoding]::new($false))
}

function Get-OpenCodeModelIds($ModelsValue) {
    if ($null -eq $ModelsValue) {
        return @()
    }
    if ($ModelsValue -is [string]) {
        if ([string]::IsNullOrWhiteSpace($ModelsValue)) { return @() }
        return @([string]$ModelsValue)
    }
    if ($ModelsValue -is [System.Array]) {
        return @($ModelsValue | ForEach-Object {
            if ($_ -is [string]) {
                [string]$_
            } elseif ($null -ne $_) {
                @($_.PSObject.Properties | ForEach-Object { [string]$_.Name })
            }
        } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    }
    return @($ModelsValue.PSObject.Properties | ForEach-Object { [string]$_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
}

function Resolve-OpenCodeRegisteredModelName {
    param(
        [Parameter(Mandatory=$true)][string]$ConfigPath,
        [Parameter(Mandatory=$true)][string]$RequestedModel
    )

    if ([string]::IsNullOrWhiteSpace($RequestedModel)) {
        throw "Requested model is required"
    }
    $resolvedConfigPath = Resolve-OpenCodeConfigPath -ConfigPath $ConfigPath
    try {
        $config = Get-Content -Raw -LiteralPath $resolvedConfigPath | ConvertFrom-Json
    } catch {
        throw "Failed to parse OpenCode config $resolvedConfigPath : $($_.Exception.Message)"
    }

    $parts = $RequestedModel.Split("/", 2)
    $requestedProvider = if ($parts.Length -eq 2) { $parts[0] } else { "" }
    $requestedModelId = if ($parts.Length -eq 2) { $parts[1] } else { $RequestedModel }
    if ([string]::IsNullOrWhiteSpace($requestedModelId)) {
        throw "Requested model id is empty: $RequestedModel"
    }

    $providerRootProperty = Get-OpenCodeConfigProperty $config "provider"
    $providerRoot = if ($null -ne $providerRootProperty) { $providerRootProperty.Value } else { $null }
    if ($null -eq $providerRoot) {
        throw "OpenCode config has no provider section: $resolvedConfigPath"
    }

    if (-not [string]::IsNullOrWhiteSpace($requestedProvider)) {
        $registeredProvider = Get-OpenCodeConfigProperty $providerRoot $requestedProvider
        if ($null -ne $registeredProvider) {
            $modelsProperty = Get-OpenCodeConfigProperty $registeredProvider.Value "models"
            $models = if ($null -ne $modelsProperty) { @(Get-OpenCodeModelIds $modelsProperty.Value) } else { @() }
            if ($models.Count -eq 0 -or ($models | ForEach-Object { [string]$_ }) -contains $requestedModelId) {
                return $RequestedModel
            }
        }
    }

    $matches = @()
    foreach ($providerProperty in @($providerRoot.PSObject.Properties)) {
        $modelsProperty = Get-OpenCodeConfigProperty $providerProperty.Value "models"
        if ($null -eq $modelsProperty) { continue }
        $modelIds = @(Get-OpenCodeModelIds $modelsProperty.Value)
        if ($modelIds -contains $requestedModelId) {
            $matches += [pscustomobject]@{
                Provider = [string]$providerProperty.Name
                Model = $requestedModelId
            }
        }
    }

    if ($matches.Count -eq 1) {
        return "$($matches[0].Provider)/$requestedModelId"
    }
    if ($matches.Count -gt 1) {
        $providers = ($matches | ForEach-Object { $_.Provider }) -join ", "
        throw "OpenCode model '$requestedModelId' is ambiguous across providers: $providers"
    }
    throw "OpenCode model '$requestedModelId' was not found in provider.*.models in $resolvedConfigPath"
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

function Get-ProbeRunArtifactNames {
    return @(
        "white-ui-notes.txt",
        "white-ui-decision.txt",
        "white-ui-audit.md"
    )
}

function ConvertTo-ProbeRunArtifactPaths([string]$Content, [string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $converted = [string]$Content
    $projectProbeRoot = Join-Path (Resolve-Path -LiteralPath ".").Path ".agent-probe"
    $projectProbeRootSlash = $projectProbeRoot -replace '\\', '/'

    foreach ($artifactName in (Get-ProbeRunArtifactNames)) {
        $escapedArtifactName = [regex]::Escape($artifactName)
        $runArtifact = Join-Path $resolvedProbeDir $artifactName
        $absoluteRootPatterns = @(
            ([regex]::Escape($projectProbeRoot) -replace '\\\\', '[\\/]'),
            ([regex]::Escape($projectProbeRootSlash) -replace '/', '[\\/]')
        ) | Select-Object -Unique

        foreach ($rootPattern in $absoluteRootPatterns) {
            $converted = [regex]::Replace(
                $converted,
                "(?<![\w.-])$rootPattern[\\/]+$escapedArtifactName",
                [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $runArtifact }
            )
        }

        $converted = [regex]::Replace(
            $converted,
            "(?<![\w.-])\.agent-probe[\\/]+$escapedArtifactName",
            [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $runArtifact }
        )
    }

    return $converted
}

function Get-ProbeRootArtifactSnapshots([string]$ProbeRoot) {
    if ([string]::IsNullOrWhiteSpace($ProbeRoot)) { throw "ProbeRoot is required" }
    return @((Get-ProbeRunArtifactNames) | ForEach-Object {
        $path = Join-Path $ProbeRoot ([string]$_)
        $exists = Test-Path -LiteralPath $path
        $lastWriteUtc = $null
        $length = $null
        if ($exists) {
            $item = Get-Item -LiteralPath $path
            $lastWriteUtc = $item.LastWriteTimeUtc
            $length = $item.Length
        }
        [pscustomobject]@{
            Name = [string]$_
            Path = $path
            Exists = $exists
            LastWriteTimeUtc = $lastWriteUtc
            Length = $length
        }
    })
}

function Assert-NoProbeRootArtifactWrites {
    param(
        [Parameter(Mandatory=$true)]$Snapshots,
        [Parameter(Mandatory=$true)][string]$ProbeDir
    )

    $changed = @()
    foreach ($snapshot in @($Snapshots)) {
        $path = [string]$snapshot.Path
        $exists = Test-Path -LiteralPath $path
        if (-not $exists) { continue }
        $item = Get-Item -LiteralPath $path
        $wasChanged = (-not [bool]$snapshot.Exists) -or
            ($item.Length -ne [int64]$snapshot.Length) -or
            ($item.LastWriteTimeUtc -ne $snapshot.LastWriteTimeUtc)
        if ($wasChanged) { $changed += $item }
    }

    if ($changed.Count -eq 0) { return }

    $evidenceDir = Join-Path (Resolve-Path -LiteralPath $ProbeDir).Path "project-root-artifact-evidence"
    New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
    foreach ($item in $changed) {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $evidenceDir $item.Name) -Force
    }
    $detail = ($changed | ForEach-Object { $_.FullName }) -join "; "
    throw "project_root_probe_artifact_written: verifier only accepts current run directory; copied root artifact evidence to $evidenceDir; changed=$detail"
}

function ConvertTo-ProbeRunPrompt([string]$Prompt, [string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedProbeDir = (Resolve-Path $ProbeDir).Path
    $converted = ConvertTo-ProbeRunArtifactPaths -Content $Prompt -ProbeDir $ProbeDir
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

function ConvertTo-ProbeRunSkill([string]$SkillContent, [string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $converted = ConvertTo-ProbeRunArtifactPaths -Content $SkillContent -ProbeDir $ProbeDir
    $override = @"

## Probe artifact directory override
For this run, the active OpenCode skill file has been materialized with run-specific artifact paths.
Use only these exact artifact paths:
- `$resolvedProbeDir\white-ui-notes.txt`
- `$resolvedProbeDir\white-ui-decision.txt`
- `$resolvedProbeDir\white-ui-audit.md`

Do not read from or write to the project-root `.agent-probe` artifact paths for this run.
"@
    return $converted + $override
}

function Set-ProbeRunSkillArtifactDirectory([string]$SkillPath, [string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($SkillPath)) { throw "SkillPath is required" }
    if (-not (Test-Path -LiteralPath $SkillPath)) { throw "Active OpenCode skill file not found: $SkillPath" }
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedSkillPath = (Resolve-Path -LiteralPath $SkillPath).Path
    $originalContent = Get-Content -Raw -LiteralPath $resolvedSkillPath
    try {
        $converted = ConvertTo-ProbeRunSkill -SkillContent $originalContent -ProbeDir $ProbeDir
        [System.IO.File]::WriteAllText($resolvedSkillPath, $converted, [System.Text.UTF8Encoding]::new($false))
    } catch {
        try {
            [System.IO.File]::WriteAllText($resolvedSkillPath, $originalContent, [System.Text.UTF8Encoding]::new($false))
        } catch {
            Write-Host "[WARN] Failed to restore active OpenCode skill after materialization failure: $_"
        }
        throw
    }
    return [pscustomobject]@{
        SkillPath = $resolvedSkillPath
        OriginalContent = $originalContent
        ProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    }
}

function Restore-ProbeRunSkillArtifactDirectory($SkillState) {
    if ($null -eq $SkillState) { return }
    $skillPath = [string]$SkillState.SkillPath
    if ([string]::IsNullOrWhiteSpace($skillPath)) { return }
    [System.IO.File]::WriteAllText($skillPath, [string]$SkillState.OriginalContent, [System.Text.UTF8Encoding]::new($false))
}

function Get-ProviderPreflightErrorInfo($ErrorRecord) {
    $message = [string]$ErrorRecord.Exception.Message
    $statusCode = $null
    try {
        if ($null -ne $ErrorRecord.Exception.Response) {
            $response = $ErrorRecord.Exception.Response
            if ($null -ne $response.StatusCode) {
                $statusCode = [int]$response.StatusCode
            }
            try {
                $stream = $response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = [System.IO.StreamReader]::new($stream)
                    try {
                        $body = $reader.ReadToEnd()
                        if (-not [string]::IsNullOrWhiteSpace($body)) {
                            $message = "$message $body"
                        }
                    } finally {
                        $reader.Dispose()
                    }
                }
            } catch {}
        }
    } catch {}

    if ($null -eq $statusCode -and $message -match '(?i)(?:status code|http|response)\D*(\d{3})') {
        $statusCode = [int]$Matches[1]
    }

    return [pscustomobject]@{
        StatusCode = $statusCode
        Message = $message
    }
}

function Test-ProviderPreflightStartupRace([int]$StatusCode, [string]$Message) {
    if ($StatusCode -ne 503) { return $false }
    if ([string]::IsNullOrWhiteSpace($Message)) { return $false }
    return $Message -match '(?i)(no\s+available\s+account|service\s+initiali[sz]ing|provider\s+initiali[sz]ing|account\s+initiali[sz]ing|proxy\s+initiali[sz]ing|initiali[sz]ing)'
}

function Invoke-ProviderPreflightWithRetry {
    param(
        [Parameter(Mandatory=$true)][scriptblock]$Request,
        [string]$Description = "provider preflight",
        [int]$StartupRetrySeconds = 8,
        [int]$StartupRetryDelayMilliseconds = 500,
        [int]$StartupRetryMaxAttempts = 20
    )

    if ($StartupRetrySeconds -lt 0) { throw "StartupRetrySeconds must be non-negative" }
    if ($StartupRetryDelayMilliseconds -lt 0) { throw "StartupRetryDelayMilliseconds must be non-negative" }
    if ($StartupRetryMaxAttempts -lt 1) { throw "StartupRetryMaxAttempts must be at least 1" }

    $attempt = 0
    $started = [DateTime]::UtcNow
    $lastStartupMessage = ""
    while ($true) {
        $attempt++
        try {
            return & $Request
        } catch {
            $info = Get-ProviderPreflightErrorInfo $_
            $statusCode = if ($null -ne $info.StatusCode) { [int]$info.StatusCode } else { 0 }
            $message = [string]$info.Message
            if (-not (Test-ProviderPreflightStartupRace -StatusCode $statusCode -Message $message)) {
                throw
            }

            $lastStartupMessage = $message
            $elapsed = ([DateTime]::UtcNow - $started).TotalSeconds
            if ($attempt -ge $StartupRetryMaxAttempts -or $elapsed -ge $StartupRetrySeconds) {
                throw "provider_preflight_startup_timeout after $attempt attempt(s) during $Description`: HTTP 503 startup race did not clear: $lastStartupMessage"
            }

            Write-Host "[WARN] Provider preflight startup race for $Description (attempt $attempt): $message"
            if ($StartupRetryDelayMilliseconds -gt 0) {
                Start-Sleep -Milliseconds $StartupRetryDelayMilliseconds
            }
        }
    }
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

function Test-IsRuntimeStructuredLogLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line)) { return $false }
    return $Line -match '\[(ProviderRuntime|Forwarder|ToolCallingEngine|ContextManagementService|Qwen|GLM|Kimi|MiniMax|MiMo|DeepSeek|Zai)\]'
}

function New-ProbeRunLogMarker([string]$ProbeDir) {
    if ([string]::IsNullOrWhiteSpace($ProbeDir)) { throw "ProbeDir is required" }
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $hashInput = "$resolvedProbeDir|$PID|$([Guid]::NewGuid().ToString("N"))"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
        $hash = $sha.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
        return "probe-run-" + $hex.Substring(0, 24)
    } finally {
        $sha.Dispose()
    }
}

function Write-StructuredLogRunMarker {
    param(
        [Parameter(Mandatory=$true)][string[]]$Paths,
        [Parameter(Mandatory=$true)][string]$ProbeDir,
        [Parameter(Mandatory=$true)][string]$MarkerId,
        [Parameter(Mandatory=$true)][ValidateSet("start", "end")][string]$Phase
    )

    if ([string]::IsNullOrWhiteSpace($MarkerId)) { throw "MarkerId is required" }
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $record = [ordered]@{
        tag = "[ProbeRun] structured-log-boundary"
        phase = $Phase
        probeRunDirectory = $resolvedProbeDir
        probeRunMarkerId = $MarkerId
        pid = $PID
        timestampUtc = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress -Depth 10

    foreach ($path in @($Paths)) {
        $target = [string]$path
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        $parent = Split-Path -Parent $target
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        [System.IO.File]::AppendAllText($target, $record + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    }
}

function Acquire-ProbeRunStructuredLogLock {
    param(
        [Parameter(Mandatory=$true)][string]$StoreDir,
        [Parameter(Mandatory=$true)][string]$ProbeDir,
        [Parameter(Mandatory=$true)][string]$MarkerId,
        [string[]]$LogSourcePaths = @()
    )

    if ([string]::IsNullOrWhiteSpace($MarkerId)) { throw "MarkerId is required" }
    if (-not (Test-Path -LiteralPath $ProbeDir)) { throw "ProbeDir does not exist: $ProbeDir" }
    New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
    $lockDir = Join-Path $StoreDir "probe-locks"
    New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
    $lockPath = Join-Path $lockDir "opencode-long-conversation-v2.structured-log.lock"
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $resolvedSources = @($LogSourcePaths | ForEach-Object {
        $source = [string]$_
        if ([string]::IsNullOrWhiteSpace($source)) { return }
        try { (Resolve-Path -LiteralPath $source).Path } catch { $source }
    })
    $metadata = [ordered]@{
        probeRunDirectory = $resolvedProbeDir
        probeRunMarkerId = $MarkerId
        logSourcePaths = $resolvedSources
        pid = $PID
        acquiredUtc = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress -Depth 20

    try {
        $stream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::Read
        )
    } catch {
        $existing = ""
        try {
            if (Test-Path -LiteralPath $lockPath) {
                $existing = Get-Content -Raw -LiteralPath $lockPath -ErrorAction SilentlyContinue
            }
        } catch {}
        throw "probe_run_lock_unavailable: another v2 long probe is already using the structured log sources. lockPath=$lockPath existing=$existing"
    }

    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($metadata)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Position = 0
        return [pscustomobject]@{
            LockPath = $lockPath
            Stream = $stream
            ProbeRunDirectory = $resolvedProbeDir
            ProbeRunMarkerId = $MarkerId
        }
    } catch {
        try { $stream.Dispose() } catch {}
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Release-ProbeRunStructuredLogLock($LockHandle) {
    if ($null -eq $LockHandle) { return }
    $lockPath = [string]$LockHandle.LockPath
    try {
        if ($LockHandle.Stream) { $LockHandle.Stream.Dispose() }
    } finally {
        if (-not [string]::IsNullOrWhiteSpace($lockPath)) {
            $shouldRemove = $false
            if (Test-Path -LiteralPath $lockPath) {
                try {
                    $json = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
                    $shouldRemove = ([string]$json.probeRunMarkerId -eq [string]$LockHandle.ProbeRunMarkerId) -and
                        ([string]$json.probeRunDirectory -eq [string]$LockHandle.ProbeRunDirectory)
                } catch {
                    $shouldRemove = $false
                }
            }
            if ($shouldRemove) {
                Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Test-IsProbeRunMarkerLine([string]$Line, [string]$ProbeDir, [string]$MarkerId, [string]$Phase) {
    if ([string]::IsNullOrWhiteSpace($Line) -or [string]::IsNullOrWhiteSpace($ProbeDir) -or [string]::IsNullOrWhiteSpace($MarkerId)) {
        return $false
    }
    try {
        $json = $Line | ConvertFrom-Json
    } catch {
        return $false
    }
    if ([string]$json.tag -ne "[ProbeRun] structured-log-boundary") { return $false }
    if ([string]$json.phase -ne $Phase) { return $false }
    if ([string]$json.probeRunMarkerId -ne $MarkerId) { return $false }
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    return ([string]$json.probeRunDirectory -eq $resolvedProbeDir)
}

function Get-StructuredLogDeltaAudit($Snapshots, [string]$ProbeDir = "", [string]$MarkerId = "") {
    $chunks = New-Object System.Collections.Generic.List[string]
    $sourcePaths = New-Object System.Collections.Generic.List[string]
    $runtimeLineCount = 0
    $runScoped = -not [string]::IsNullOrWhiteSpace($ProbeDir) -and -not [string]::IsNullOrWhiteSpace($MarkerId)
    $startMarkerCount = 0
    $endMarkerCount = 0
    foreach ($snapshot in @($Snapshots)) {
        $path = [string]$snapshot.Path
        $before = [int]$snapshot.LineCount
        if (-not (Test-Path $path)) { continue }
        $lines = @(Get-Content -LiteralPath $path)
        if ($lines.Count -le $before) { continue }
        $delta = @($lines | Select-Object -Skip $before | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($delta.Count -le 0) { continue }
        $sourceHadRuntime = $false
        $insideRunWindow = -not $runScoped
        foreach ($line in $delta) {
            $text = [string]$line
            if ($runScoped -and (Test-IsProbeRunMarkerLine -Line $text -ProbeDir $ProbeDir -MarkerId $MarkerId -Phase "start")) {
                $startMarkerCount++
                $insideRunWindow = $true
                continue
            }
            if ($runScoped -and (Test-IsProbeRunMarkerLine -Line $text -ProbeDir $ProbeDir -MarkerId $MarkerId -Phase "end")) {
                $endMarkerCount++
                $insideRunWindow = $false
                continue
            }
            if (-not $insideRunWindow) { continue }
            $chunks.Add($text) | Out-Null
            if (Test-IsRuntimeStructuredLogLine $text) {
                $runtimeLineCount++
                $sourceHadRuntime = $true
            }
        }
        if ($sourceHadRuntime) { $sourcePaths.Add($path) | Out-Null }
    }
    return [pscustomobject]@{
        Text = ($chunks -join [Environment]::NewLine)
        SourcePaths = @($sourcePaths)
        RuntimeStructuredLogLineCount = $runtimeLineCount
        ProbeRunMarkerId = $MarkerId
        ProbeRunStartMarkerCount = $startMarkerCount
        ProbeRunEndMarkerCount = $endMarkerCount
        IsRunScoped = $runScoped
    }
}

function Update-SessionReportRunMetadata {
    param(
        [Parameter(Mandatory=$true)][string]$ReportPath,
        [Parameter(Mandatory=$true)][string]$ProbeDir,
        [string[]]$LogSourcePaths = @(),
        [int]$RuntimeStructuredLogLineCount = 0,
        [string]$ProbeRunMarkerId = "",
        [int]$ProbeRunStartMarkerCount = 0,
        [int]$ProbeRunEndMarkerCount = 0,
        $ProbeRunLockHandle = $null
    )

    if (-not (Test-Path -LiteralPath $ReportPath)) { throw "session report not found: $ReportPath" }
    if (-not (Test-Path -LiteralPath $ProbeDir)) { throw "probe run directory not found: $ProbeDir" }
    if ($RuntimeStructuredLogLineCount -lt 1) { throw "session report metadata requires at least one runtime structured log line" }
    if ([string]::IsNullOrWhiteSpace($ProbeRunMarkerId)) { throw "session report metadata requires a probe run marker id" }
    if ($ProbeRunStartMarkerCount -lt 1 -or $ProbeRunEndMarkerCount -lt 1) {
        throw "session report metadata requires matching probe run start/end log markers"
    }

    $json = Get-Content -Raw -LiteralPath $ReportPath | ConvertFrom-Json
    $resolvedProbeDir = (Resolve-Path -LiteralPath $ProbeDir).Path
    $resolvedSources = @($LogSourcePaths | ForEach-Object {
        $source = [string]$_
        if ([string]::IsNullOrWhiteSpace($source)) { return }
        try { (Resolve-Path -LiteralPath $source).Path } catch { $source }
    })
    if ($resolvedSources.Count -lt 1) { throw "session report metadata requires at least one log source path" }
    if ($null -eq $ProbeRunLockHandle) { throw "session report metadata requires the active probe run structured log lock" }
    $lockPath = [string]$ProbeRunLockHandle.LockPath
    if ([string]::IsNullOrWhiteSpace($lockPath) -or -not (Test-Path -LiteralPath $lockPath)) {
        throw "session report metadata requires an active structured log lock file"
    }
    $lockJson = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
    if ([string]$lockJson.probeRunDirectory -ne $resolvedProbeDir) {
        throw "session report metadata lock run directory mismatch"
    }
    if ([string]$lockJson.probeRunMarkerId -ne $ProbeRunMarkerId) {
        throw "session report metadata lock marker mismatch"
    }
    $lockSources = @($lockJson.logSourcePaths | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lockSources.Count -lt 1) { throw "session report metadata lock has no log source paths" }
    foreach ($source in $resolvedSources) {
        if ($lockSources -notcontains [string]$source) {
            throw "session report metadata log source was not covered by the active lock: $source"
        }
    }

    $json | Add-Member -NotePropertyName probeRunDirectory -NotePropertyValue $resolvedProbeDir -Force
    $json | Add-Member -NotePropertyName probeRunMarkerId -NotePropertyValue $ProbeRunMarkerId -Force
    $json | Add-Member -NotePropertyName logSourcePaths -NotePropertyValue $resolvedSources -Force
    $json | Add-Member -NotePropertyName runtimeStructuredLogLineCount -NotePropertyValue $RuntimeStructuredLogLineCount -Force
    $json | Add-Member -NotePropertyName probeRunStartMarkerCount -NotePropertyValue $ProbeRunStartMarkerCount -Force
    $json | Add-Member -NotePropertyName probeRunEndMarkerCount -NotePropertyValue $ProbeRunEndMarkerCount -Force
    $json | Add-Member -NotePropertyName structuredLogLockPath -NotePropertyValue $lockPath -Force
    $json | Add-Member -NotePropertyName structuredLogLockProbeRunDirectory -NotePropertyValue ([string]$lockJson.probeRunDirectory) -Force
    $json | Add-Member -NotePropertyName structuredLogLockMarkerId -NotePropertyValue ([string]$lockJson.probeRunMarkerId) -Force
    $json | Add-Member -NotePropertyName structuredLogLockSourcePaths -NotePropertyValue $lockSources -Force
    $json | Add-Member -NotePropertyName structuredLogLockAcquiredUtc -NotePropertyValue ([string]$lockJson.acquiredUtc) -Force
    $json | ConvertTo-Json -Depth 20 | Out-File -LiteralPath $ReportPath -Encoding UTF8
    return $json
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

function Wait-ProcessExitWithin($Process, [int]$TimeoutMilliseconds) {
    if ($null -eq $Process) { return $true }
    try { return $Process.WaitForExit($TimeoutMilliseconds) } catch { return $true }
}

function Get-ProcessSnapshotForTree {
    try {
        return @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        return @()
    }
}

function Get-LoggedProcessTreePids([int]$RootProcessId) {
    $seen = @{}
    $childrenByParent = @{}
    foreach ($processInfo in @(Get-ProcessSnapshotForTree)) {
        try {
            $parentPid = [int]$processInfo.ParentProcessId
            $childPid = [int]$processInfo.ProcessId
        } catch {
            continue
        }
        $parentKey = [string]$parentPid
        if (-not $childrenByParent.ContainsKey($parentKey)) {
            $childrenByParent[$parentKey] = New-Object System.Collections.Generic.List[int]
        }
        $childrenByParent[$parentKey].Add($childPid)
    }

    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootProcessId)
    $seen[[string]$RootProcessId] = $true

    while ($queue.Count -gt 0) {
        $currentPid = $queue.Dequeue()
        $children = @()
        $currentKey = [string]$currentPid
        if ($childrenByParent.ContainsKey($currentKey)) {
            $children = @($childrenByParent[$currentKey])
        }
        foreach ($childPid in $children) {
            if (-not $seen.ContainsKey([string]$childPid)) {
                $seen[[string]$childPid] = $true
                $queue.Enqueue($childPid)
            }
        }
    }

    return @($seen.Keys | ForEach-Object { [int]$_ })
}

function Stop-LoggedProcessByIdBounded([int]$ProcessId, [int]$TimeoutMilliseconds = 5000) {
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not (Test-ProcessIsRunning $ProcessId)) { return $true }
            Start-Sleep -Milliseconds 100
        }
        return -not (Test-ProcessIsRunning $ProcessId)
    } catch {
        throw
    }
}

function Invoke-TaskkillTreeBounded([int]$ProcessId, [int]$TimeoutMilliseconds = 5000) {
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($null -eq $taskkill) { return $false }
    $taskkillPath = Resolve-CommandPath $taskkill
    if ([string]::IsNullOrWhiteSpace($taskkillPath)) { return $false }

    $redirectPrefix = Join-Path ([System.IO.Path]::GetTempPath()) ("chat2api-taskkill-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
    $stdoutPath = "$redirectPrefix.out"
    $stderrPath = "$redirectPrefix.err"
    $taskkillProcess = $null
    try {
        $taskkillProcess = Start-Process `
            -FilePath $taskkillPath `
            -ArgumentList @("/PID", [string]$ProcessId, "/T", "/F") `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        if (-not $taskkillProcess.WaitForExit($TimeoutMilliseconds)) {
            try { $taskkillProcess.Kill() } catch {}
            return $false
        }
        return $taskkillProcess.ExitCode -eq 0
    } finally {
        try { $taskkillProcess.Dispose() } catch {}
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
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
    $cleanupEvidence = New-Object System.Collections.Generic.List[string]
    try {
        if ($Handle.Process) {
            $pidToKill = [int]$Handle.Process.Id
            try { $Handle.Process.Refresh() } catch {}
            if ($Handle.Process.HasExited -or -not (Test-ProcessIsRunning $pidToKill)) { return }

            $treePids = @(Get-LoggedProcessTreePids $pidToKill | Sort-Object -Descending)
            if ($treePids.Count -eq 0 -or $treePids -notcontains $pidToKill) {
                $treePids = @($pidToKill)
            }
            $cleanupEvidence.Add(("tree=[{0}]" -f ($treePids -join ","))) | Out-Null

            $killed = $false
            if ($IsWindows -or $env:OS -eq "Windows_NT") {
                try {
                    $killed = Invoke-TaskkillTreeBounded -ProcessId $pidToKill -TimeoutMilliseconds 5000
                    $cleanupEvidence.Add("taskkill=$killed") | Out-Null
                    if ($killed) {
                        Start-Sleep -Milliseconds 200
                        $killed = -not (Test-ProcessIsRunning $pidToKill)
                        $cleanupEvidence.Add("taskkill_root_exited=$killed") | Out-Null
                    }
                } catch {
                    $cleanupEvidence.Add("taskkill_error=$($_.Exception.Message)") | Out-Null
                }
            }
            if (-not $killed) {
                try {
                    $Handle.Process.Kill($true)
                    $cleanupEvidence.Add("process_kill_tree=true") | Out-Null
                } catch {
                    $cleanupEvidence.Add("process_kill_tree_error=$($_.Exception.Message)") | Out-Null
                    foreach ($treePid in $treePids) {
                        try {
                            Stop-LoggedProcessByIdBounded -ProcessId $treePid -TimeoutMilliseconds 1000 | Out-Null
                            $cleanupEvidence.Add("stop_pid_${treePid}=true") | Out-Null
                        } catch {
                            $cleanupEvidence.Add("stop_pid_${treePid}_error=$($_.Exception.Message)") | Out-Null
                        }
                    }
                }
            }
            Wait-ProcessExitWithin -Process $Handle.Process -TimeoutMilliseconds 5000 | Out-Null
            try { $Handle.Process.Refresh() } catch {}
            $survivors = @($treePids | Where-Object { Test-ProcessIsRunning $_ })
            if (($Handle.Process.HasExited -or -not (Test-ProcessIsRunning $pidToKill)) -and $survivors.Count -eq 0) {
                return
            }
            if ($survivors.Count -gt 0) {
                throw "logged process tree root PID $pidToKill is still running after Stop-LoggedProcess; survivors=[$($survivors -join ',')]; evidence=$($cleanupEvidence -join '; ')"
            }
        }
    } finally {
        if ($Handle.Process) { $Handle.Process.Dispose() }
        if ($Handle.WrapperPath) { Remove-Item -LiteralPath $Handle.WrapperPath -Force -ErrorAction SilentlyContinue }
    }
}
