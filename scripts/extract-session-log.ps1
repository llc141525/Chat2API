<#
.SYNOPSIS
  从 dev.log 提取会话时间线，高信噪比汇总

.DESCRIPTION
  只抓取两类信息：
    A. 每个请求的 JSON trace 行（一条包含全部边信息）
    B. 关键事件（summary 成败、错误、session 清理）

  输出：
    1. 终端时间线表格（一 session 一行）
    2. 自动问题检测
    3. JSON 报告

.PARAMETER LogPath
  dev.log 路径，默认 ./dev.log

.EXAMPLE
  .\scripts\extract-session-log.ps1
  .\scripts\extract-session-log.ps1 -LogPath dev-qwen.log
#>

param(
  [string]$LogPath = (Join-Path (Get-Location) "dev.log"),
  [string]$OutputDir = (Join-Path (Get-Location) "session-reports"),
  [string]$EventsPath = "",
  [string]$Provider = "",
  [switch]$RequireExecutionEnvironmentAnchor,
  [int]$MaxInterToolGapMs = 45000,
  [switch]$Strict,
  [switch]$JsonOnly
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $LogPath)) {
  Write-Host "[ERROR] $LogPath not found" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

function Get-TraceRequestId($data) {
  if ($null -eq $data) { return 'unknown' }
  foreach ($name in @('correlationId', 'requestId')) {
    if ($data.PSObject.Properties.Name -contains $name) {
      $value = [string]$data.$name
      if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
    }
  }
  return 'unknown'
}

# ============================================================
# Phase 1: 提取所有结构化 trace 行 + 关键事件
# ============================================================

$RE_TRACE    = '\[Forwarder\] Runtime pilot request trace:\s*(\{.+\})$'
$RE_TOOL     = '\[Forwarder\] Tool transform trace:\s*(\{.+\})$'
$RE_SUMM_OK  = '\[SummaryGenerator\] Summary generated successfully, length:\s*(\d+)'
$RE_SUMM_HANDOFF = '\[SummaryStrategy\] Skipping external summary generation during active tool workflow'
$RE_SUMM_REJ = '\[SummaryGenerator\] Rejected summary input quality:.*"reason":"([^"]+)"'
$RE_SUMM_FAIL= '\[SummaryGenerator\] Failed to generate summary'
$RE_CTX      = '\[Forwarder\] Context management applied:\s*(\d+)\s*->\s*(\d+)'
$RE_COMPACT  = '\[ContextEconomy\] compatibility_summary_extraction.*"summaryChars":(\d+)'
$RE_MALFORM  = '\[Forwarder\] Malformed tool output detected'
$RE_FALLBACK = '\[Forwarder\] dedicated_provider_fallback'
$RE_QWEN_SES = '\[Qwen\] Session info:.*sessionId:\s*''([^'']+)''.*reqId:\s*''([^'']+)'''
$RE_GLM_CONV = '\[GLM\] Sending chat request'
$RE_QWEN_ASSEMBLY = '\[Qwen\] Request assembly trace:\s*(\{.+\})$'
$RE_RUNTIME_ECONOMY = '\[ProviderRuntime\] Context economy:\s*(\{.+\})$'
$RE_ATTEMPT_FAIL = '\[Forwarder\] Provider request attempt (?:failed|threw):\s*(\{.+\})$'
$RE_DEL      = '(Session deleted|Conversation deleted).*:\s*(\S+)'
$RE_ERR      = '\[(Qwen|GLM|DeepSeek|Kimi|Forwarder)\]\s+(Failed|Error):?\s*(.+)'

$records = @()
$lineNum = 0
Get-Content $LogPath -Encoding UTF8 | ForEach-Object {
  $lineNum++
  $line = $_

  if ($line -match $RE_TRACE) {
    try { $data = $matches[1] | ConvertFrom-Json } catch { $data = $null }
    $records += [PSCustomObject]@{
      line       = $lineNum
      kind       = 'request'
      requestId  = Get-TraceRequestId $data
      provider   = if ($data) { $data.providerId } else { '' }
      boundary   = if ($data) { $data.sessionBoundaryReason } else { '?' }
      toolKey    = if ($data) { $data.toolSessionKeyPresent } else { $false }
      isChild    = if ($data) { $data.providerConversationSessionKeyIsChild } else { $false }
      refresh    = if ($data) { $data.promptRefreshMode } else { '' }
      raw        = $data
    }
    return
  }

  if ($line -match $RE_TOOL) {
    try { $data = $matches[1] | ConvertFrom-Json } catch { $data = $null }
    $records += [PSCustomObject]@{
      line       = $lineNum
      kind       = 'tool_transform'
      requestId  = Get-TraceRequestId $data
      planMode   = if ($data) { $data.planMode } else { '' }
      injected   = if ($data) { $data.injected } else { $false }
      catalogSrc = if ($data) { $data.catalogSource } else { '' }
    }
    return
  }

  if ($line -match $RE_SUMM_OK) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'summary_ok'; length = [int]$matches[1] }
    return
  }
  if ($line -match $RE_SUMM_HANDOFF) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'summary_handoff' }
    return
  }
  if ($line -match $RE_SUMM_REJ) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'summary_rejected'; reason = $matches[1] }
    return
  }
  if ($line -match $RE_SUMM_FAIL) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'summary_failed' }
    return
  }

  if ($line -match $RE_CTX) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'context'; before = [int]$matches[1]; after = [int]$matches[2] }
    return
  }
  if ($line -match $RE_COMPACT) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'compact_extract'; chars = [int]$matches[1] }
    return
  }
  if ($line -match $RE_MALFORM) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'malformed_retry' }
    return
  }
  if ($line -match $RE_FALLBACK) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'dedicated_fallback' }
    return
  }

  if ($line -match $RE_QWEN_SES) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'provider_session'; sessionId = $matches[1]; reqId = $matches[2] }
    return
  }
  if ($line -match $RE_GLM_CONV) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'glm_chat_send' }
    return
  }

  if ($line -match $RE_DEL) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'session_deleted'; id = $matches[2] }
    return
  }

  if ($line -match $RE_ERR) {
    $records += [PSCustomObject]@{ line = $lineNum; kind = 'error'; provider = $matches[1]; msg = $matches[3].Substring(0, [Math]::Min(140, $matches[3].Length)) }
    return
  }

  if ($line -match $RE_QWEN_ASSEMBLY) {
    try { $data = $matches[1] | ConvertFrom-Json } catch { $data = $null }
    $records += [PSCustomObject]@{
      line = $lineNum; kind = 'qwen_assembly'; raw = $data
      finalChars = if ($data) { [int]$data.finalContentLength } else { 0 }
      environmentAnchor = if ($data) { [bool]$data.hasExecutionEnvironmentAnchor } else { $false }
    }
    return
  }

  if ($line -match $RE_RUNTIME_ECONOMY) {
    try { $data = $matches[1] | ConvertFrom-Json } catch { $data = $null }
    $records += [PSCustomObject]@{
      line = $lineNum; kind = 'runtime_economy'; raw = $data
      requestId = Get-TraceRequestId $data
      providerAction = if ($data) { [string]$data.providerSessionAction } else { '' }
      providerSessionSource = if ($data) { [string]$data.providerSessionIdSource } else { '' }
      repeatedRuntimeMarkers = if ($data -and $data.contextEconomy) { [int]$data.contextEconomy.repeatedRuntimeConfigMarkers } else { 0 }
      repeatedToolContractMarkers = if ($data -and $data.contextEconomy) { [int]$data.contextEconomy.repeatedToolContractMarkers } else { 0 }
    }
    return
  }

  if ($line -match $RE_ATTEMPT_FAIL) {
    try { $data = $matches[1] | ConvertFrom-Json } catch { $data = $null }
    $records += [PSCustomObject]@{
      line = $lineNum; kind = 'provider_attempt_failure'; raw = $data
      provider = if ($data) { [string]$data.providerId } else { '' }
      attempt = if ($data) { [int]$data.attempt } else { 0 }
      maxAttempts = if ($data) { [int]$data.maxAttempts } else { 0 }
      status = if ($data) { [int]$data.status } else { 0 }
      boundary = if ($data) { [string]$data.boundary } else { '' }
      message = if ($data) { [string]$data.error } else { 'unparseable provider attempt failure' }
    }
    return
  }
}

if (-not [string]::IsNullOrWhiteSpace($Provider)) {
  $records = @($records | Where-Object {
    $_.kind -notin @('request', 'error', 'provider_attempt_failure') -or [string]::Equals([string]$_.provider, $Provider, [StringComparison]::OrdinalIgnoreCase)
  })
}

Write-Host ("[+] Extracted {0} signal records from {1} lines ({2:N1}% hit rate)" -f
  $records.Count, $lineNum, ($records.Count / [Math]::Max(1, $lineNum) * 100)) -ForegroundColor Green

if ($records.Count -eq 0) {
  Write-Host "[-] No signals found." -ForegroundColor Yellow
  exit 0
}

# ============================================================
# Phase 2: 构建时间线 —— 按 request 切分 session，事件就近归属
# ============================================================

$sessions = @()
$sessionsByRequestId = @{}
$currentId = 0
$pendingToolTransform = $null

foreach ($r in $records) {
  if ($r.kind -eq 'request') {
    $currentId++
    $requestId = if ($r.requestId) { [string]$r.requestId } else { 'unknown' }
    $toolTransformForRequest = $null
    if ($null -ne $pendingToolTransform) {
      $pendingRequestId = if ($pendingToolTransform.requestId) { [string]$pendingToolTransform.requestId } else { 'unknown' }
      if ($pendingRequestId -eq 'unknown' -or $pendingRequestId -eq $requestId) {
        $toolTransformForRequest = $pendingToolTransform
      }
    }
    $sessions += [PSCustomObject]@{
      id            = $currentId
      line          = $r.line
      requestId     = $requestId
      correlationId = $requestId
      provider      = $r.provider
      boundary      = $r.boundary
      toolKey       = $r.toolKey
      isChild       = $r.isChild
      refresh       = $r.refresh
      provSessionId = ''
      provReqId     = ''
      toolPlan      = if ($null -ne $toolTransformForRequest) { $toolTransformForRequest.planMode } else { '' }
      toolCatalog   = if ($null -ne $toolTransformForRequest) { $toolTransformForRequest.catalogSrc } else { '' }
      summaryOk     = 0
      summaryHandoff = $false
      summaryRej    = ''
      summaryFail   = $false
      ctxBefore     = 0
      ctxAfter      = 0
      compactChars  = 0
      malformed     = $false
      fallback      = $false
      errors        = @()
      deleted       = @()
      assemblyChars = 0
      environmentAnchor = $false
      providerAction = ''
      providerSessionSource = ''
      repeatedRuntimeMarkers = 0
      repeatedToolContractMarkers = 0
      eventLines    = if ($null -ne $toolTransformForRequest) { @($toolTransformForRequest.line) } else { @() }
    }
    if ($requestId -ne 'unknown') {
      $sessionsByRequestId[$requestId] = $sessions[-1]
    }
    if ($null -ne $toolTransformForRequest) {
      $pendingToolTransform = $null
    }
  }
  elseif ($r.kind -eq 'provider_session' -and $sessions.Count -gt 0) {
    $sessions[-1].provSessionId = $r.sessionId
    $sessions[-1].provReqId = $r.reqId
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'tool_transform') {
    $pendingToolTransform = $r
  }
  elseif ($r.kind -match 'summary_' -and $sessions.Count -gt 0) {
    switch ($r.kind) {
      'summary_ok'       { $sessions[-1].summaryOk = $r.length }
      'summary_handoff'  { $sessions[-1].summaryHandoff = $true }
      'summary_rejected' { $sessions[-1].summaryRej = $r.reason }
      'summary_failed'   { $sessions[-1].summaryFail = $true }
    }
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'context' -and $sessions.Count -gt 0) {
    $sessions[-1].ctxBefore = $r.before
    $sessions[-1].ctxAfter = $r.after
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'compact_extract' -and $sessions.Count -gt 0) {
    $sessions[-1].compactChars = $r.chars
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'malformed_retry' -and $sessions.Count -gt 0) {
    $sessions[-1].malformed = $true
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'dedicated_fallback' -and $sessions.Count -gt 0) {
    $sessions[-1].fallback = $true
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'error' -and $sessions.Count -gt 0) {
    $sessions[-1].errors += $r
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'session_deleted') {
    # attach to most recent session that had provider session
    foreach ($s in ($sessions | Sort-Object id -Descending)) {
      if ($s.provSessionId) { $s.deleted += $r.id; $s.eventLines += $r.line; break }
    }
  }
  elseif ($r.kind -eq 'glm_chat_send' -and $sessions.Count -gt 0) {
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'qwen_assembly' -and $sessions.Count -gt 0) {
    $sessions[-1].assemblyChars = $r.finalChars
    $sessions[-1].environmentAnchor = $r.environmentAnchor
    $sessions[-1].eventLines += $r.line
  }
  elseif ($r.kind -eq 'runtime_economy' -and $sessions.Count -gt 0) {
    $requestId = if ($r.requestId) { [string]$r.requestId } else { 'unknown' }
    $targetSession = if ($requestId -ne 'unknown' -and $sessionsByRequestId.ContainsKey($requestId)) {
      $sessionsByRequestId[$requestId]
    } else {
      $sessions[-1]
    }
    $targetSession.providerAction = $r.providerAction
    $targetSession.providerSessionSource = $r.providerSessionSource
    $targetSession.repeatedRuntimeMarkers = $r.repeatedRuntimeMarkers
    $targetSession.repeatedToolContractMarkers = $r.repeatedToolContractMarkers
    $targetSession.eventLines += $r.line
  }
}

if ($sessions.Count -eq 0) { Write-Host "[-] No request traces found." -ForegroundColor Yellow; exit 0 }

# ============================================================
# Phase 3: 分类 + 终端输出
# ============================================================

function Classify($s) {
  if ($s.boundary -eq 'tool_child')     { return 'tool_child', '@', 'Magenta' }
  if ($s.boundary -eq 'subagent_child') { return 'subagent', '@', 'Magenta' }
  if ($s.boundary -eq 'client_compact') { return 'compact', '~', 'Yellow' }
  if ($s.boundary -eq 'server_summary') { return 'srv_summary', 'S', 'DarkYellow' }
  if ($s.toolKey)                       { return 'tool', '*', 'Cyan' }
  return 'main', '#', 'Green'
}

# --- 时间线表格 ---
$header = "{0,3} {1,1} {2,-11} {3,-10} {4,-14} {5,-8} {6,-12} {7,-25} {8}" -f
  'ID', '', 'TYPE', 'PROVIDER', 'REQ_ID', 'REFRESH', 'PLAN/CATALOG', 'PROVIDER_SESSION', 'EVENTS'
Write-Host "`n$header" -ForegroundColor White
Write-Host ('-' * 120) -ForegroundColor DarkGray

foreach ($s in $sessions) {
  $class, $icon, $color = Classify $s

  $refreshStr = if ($s.refresh -and $s.refresh -ne 'none') { $s.refresh } else { '-' }
  $planStr = if ($s.toolPlan) { "$($s.toolPlan)/$($s.toolCatalog)" } else { '-' }
  $provStr = if ($s.provSessionId) {
    $s.provSessionId.Substring(0, [Math]::Min(24, $s.provSessionId.Length))
  } else { '-' }
  $requestStr = if ($s.requestId) {
    $s.requestId.Substring(0, [Math]::Min(14, $s.requestId.Length))
  } else { 'unknown' }

  # Events compact format
  $evtParts = @()
  if ($s.summaryOk -gt 0)    { $evtParts += "summ=${s.summaryOk}ch" }
  if ($s.summaryRej)         {
    $short = $s.summaryRej -replace 'no_text_content|empty_messages|tool_only_history|insufficient_content', 'no_text'
    $evtParts += "REJ:$short"
  }
  if ($s.summaryFail)        { $evtParts += 'summ:FAIL' }
  if ($s.ctxBefore -gt 0)    { $evtParts += "ctx:$($s.ctxBefore)->$($s.ctxAfter)" }
  if ($s.compactChars -gt 0) { $evtParts += "compact:${s.compactChars}ch" }
  if ($s.malformed)          { $evtParts += 'MALFORMED' }
  if ($s.fallback)           { $evtParts += 'FALLBACK' }
  if ($s.deleted.Count -gt 0){ $evtParts += "del:$($s.deleted -join ',')" }
  if ($s.errors.Count -gt 0) { $evtParts += "ERRx$($s.errors.Count)" }
  $evtStr = $evtParts -join ' '

  $line = "{0,3} {1,1} {2,-11} {3,-10} {4,-14} {5,-8} {6,-12} {7,-25} {8}" -f `
    $s.id, $icon, $class, $s.provider, $requestStr, $refreshStr, $planStr, $provStr, $evtStr

  if ($s.errors.Count -gt 0 -or $s.summaryRej -or $s.fallback -or $s.malformed) {
    Write-Host $line -ForegroundColor $color -BackgroundColor DarkRed
  } else {
    Write-Host $line -ForegroundColor $color
  }
}

# --- 错误详情（只在有错误时展开） ---
$allErrors = $sessions | Where-Object { $_.errors.Count -gt 0 }
if ($allErrors) {
  Write-Host "`n=== Errors ===" -ForegroundColor Red
  foreach ($s in $allErrors) {
    foreach ($e in $s.errors) {
      Write-Host "  #$($s.id) L$($e.line): [$($e.provider)] $($e.msg)" -ForegroundColor Red
    }
  }
}

# ============================================================
# Phase 4: 自动诊断
# ============================================================

Write-Host "`n=== Diagnostics ===" -ForegroundColor Cyan
$issues = @()

# Summary rejected 意味着什么
foreach ($s in ($sessions | Where-Object { $_.summaryRej })) {
  $issues += "#$($s.id) L$($s.line): summary REJECTED reason='$($s.summaryRej)' — model would see empty/invalid summary in compact"
}

# The first compact turn must establish a new provider epoch; later active-tool
# handoff turns are expected to reuse that epoch. Flag only an explicit fresh
# boundary that still reuses a session, not all session reuse after compaction.
foreach ($s in $sessions) {
  $isCompactBoundary = $s.boundary -eq 'client_compact' -or $s.boundary -eq 'server_summary'
  if ($isCompactBoundary -and $s.providerAction -eq 'start_fresh' -and $s.providerSessionSource -eq 'state') {
    $issues += "#$($s.id) L$($s.line): start_fresh boundary reused provider state — compact epoch may be stale"
  }
  if ($RequireExecutionEnvironmentAnchor -and $s.provider -eq 'qwen' -and $isCompactBoundary -and -not $s.environmentAnchor) {
    $issues += "#$($s.id) L$($s.line): compacted Qwen request lacks execution-environment anchor"
  }
  $knownQwenAction = $s.providerAction -eq 'reuse_parent' -or $s.providerAction -eq 'start_fresh' -or $s.providerAction -eq 'start_child' -or $s.providerAction -eq 'consume_child_handoff'
  if ($s.provider -eq 'qwen' -and $s.providerAction -and -not $knownQwenAction) {
    $issues += "#$($s.id) L$($s.line): unknown Qwen provider session action '$($s.providerAction)'"
  }
  if ($s.repeatedRuntimeMarkers -gt 0) {
    $issues += "#$($s.id) L$($s.line): repeated runtime configuration markers=$($s.repeatedRuntimeMarkers)"
  }
  if ($s.repeatedToolContractMarkers -gt 0) {
    $issues += "#$($s.id) L$($s.line): repeated tool-contract markers=$($s.repeatedToolContractMarkers)"
  }
}

# tool session 的 tool plan 是否异常
foreach ($s in ($sessions | Where-Object { $_.toolKey -and $_.toolPlan -eq '' })) {
  $issues += "#$($s.id) L$($s.line): tool session but no tool_transform trace — injection may have failed"
}

# dedicated fallback = 架构回退
foreach ($s in ($sessions | Where-Object { $_.fallback })) {
  $issues += "#$($s.id) L$($s.line): used dedicated_fallback — provider runtime was bypassed"
}

foreach ($failure in ($records | Where-Object { $_.kind -eq 'provider_attempt_failure' })) {
  $issues += "L$($failure.line): provider request failed (attempt $($failure.attempt)/$($failure.maxAttempts), status=$($failure.status), boundary=$($failure.boundary)): $($failure.message)"
}

# context management 未触发 summary 引导
foreach ($s in ($sessions | Where-Object { $_.ctxBefore -gt 0 -and $_.summaryOk -eq 0 -and -not $_.summaryHandoff -and $_.summaryRej -eq '' -and -not $_.summaryFail })) {
  $issues += "#$($s.id) L$($s.line): context reduced $($s.ctxBefore)->$($s.ctxAfter) but NO summary trace — truncation without compaction?"
}

# 缺 session 清理
$toolChildSessions = $sessions | Where-Object { $_.boundary -eq 'tool_child' -and $_.provSessionId }
foreach ($s in $toolChildSessions) {
  if ($s.deleted.Count -eq 0) {
    $issues += "#$($s.id) L$($s.line): tool_child session $($s.provSessionId) not cleaned up"
  }
}

$eventAudit = [ordered]@{
  source = $EventsPath
  parsed = $false
  toolCalls = 0
  maxInterToolGapMs = 0
  duplicateAdjacentToolInputs = @()
  failedToolEvents = @()
  rawProtocolTextEvents = @()
}
if (-not [string]::IsNullOrWhiteSpace($EventsPath)) {
  if (-not (Test-Path $EventsPath)) {
    $issues += "event audit requested but file was not found: $EventsPath"
  } else {
    $lastToolTimestamp = $null
    $previousToolSignature = ''
    $eventLine = 0
    foreach ($eventRaw in @(Get-Content $EventsPath -Encoding UTF8)) {
      $eventLine++
      if ([string]::IsNullOrWhiteSpace($eventRaw)) { continue }
      try { $event = $eventRaw | ConvertFrom-Json } catch {
        $issues += "event L${eventLine}: invalid NDJSON"
        continue
      }
      $eventAudit.parsed = $true
      $eventText = $eventRaw
      if ([string]$event.type -eq 'text' -and $eventText -match '<\|CHAT2API\|(?:tool_calls|invoke|parameter)|</(?:tool_call|arg_value)>') {
        $eventAudit.rawProtocolTextEvents += $eventLine
      }
      if ([string]$event.type -ne 'tool_use') { continue }
      $tool = [string]$event.part.tool
      $toolStatus = [string]$event.part.state.status
      if ($toolStatus -and $toolStatus -ne 'completed') {
        $eventAudit.failedToolEvents += $eventLine
      }
      $input = if ($null -ne $event.part.state.input) { $event.part.state.input | ConvertTo-Json -Compress -Depth 20 } else { '' }
      $signature = "$tool|$input"
      $eventAudit.toolCalls++
      if ($signature -eq $previousToolSignature) {
        $eventAudit.duplicateAdjacentToolInputs += $eventLine
      }
      $previousToolSignature = $signature
      $timestamp = if ($null -ne $event.timestamp) { [int64]$event.timestamp } else { [int64]0 }
      if ($lastToolTimestamp -ne $null -and $timestamp -gt $lastToolTimestamp) {
        $gap = $timestamp - $lastToolTimestamp
        if ($gap -gt $eventAudit.maxInterToolGapMs) { $eventAudit.maxInterToolGapMs = $gap }
      }
      if ($timestamp -gt 0) { $lastToolTimestamp = $timestamp }
    }
    foreach ($line in $eventAudit.duplicateAdjacentToolInputs) {
      $issues += "event L${line}: duplicate adjacent tool input"
    }
    foreach ($line in $eventAudit.failedToolEvents) {
      $issues += "event L${line}: tool event did not complete"
    }
    foreach ($line in $eventAudit.rawProtocolTextEvents) {
      $issues += "event L${line}: raw managed-tool protocol leaked as assistant text"
    }
    if ($eventAudit.toolCalls -gt 1 -and $eventAudit.maxInterToolGapMs -gt $MaxInterToolGapMs) {
      $issues += "event audit: maximum tool-to-tool gap $($eventAudit.maxInterToolGapMs)ms exceeds ${MaxInterToolGapMs}ms"
    }
  }
}

if ($issues.Count -eq 0) {
  Write-Host "  No issues detected." -ForegroundColor Green
} else {
  foreach ($i in $issues) {
    Write-Host "  $i" -ForegroundColor Yellow
  }
}

# ============================================================
# Phase 5: JSON 报告
# ============================================================

if (-not $JsonOnly) {
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $report = [PSCustomObject]@{
    generated   = (Get-Date).ToString('o')
    source      = $LogPath
    totalLines  = $lineNum
    signalCount = $records.Count
    sessionCount= $sessions.Count
    issues      = $issues
    eventAudit  = $eventAudit
    sessions    = @($sessions | ForEach-Object {
      [PSCustomObject]@{
        id        = $_.id
        line      = $_.line
        requestId = $_.requestId
        correlationId = $_.correlationId
        type      = (Classify $_)[0]
        provider  = $_.provider
        boundary  = $_.boundary
        toolKey   = $_.toolKey
        isChild   = $_.isChild
        refresh   = $_.refresh
        provSessionId = $_.provSessionId
        provReqId = $_.provReqId
        toolPlan  = $_.toolPlan
        toolCatalog = $_.toolCatalog
        summaryOk = $_.summaryOk
        summaryRej = $_.summaryRej
        summaryFail = $_.summaryFail
        ctxBefore = $_.ctxBefore
        ctxAfter  = $_.ctxAfter
        compactChars = $_.compactChars
        malformed = $_.malformed
        fallback  = $_.fallback
        providerAction = $_.providerAction
        providerSessionSource = $_.providerSessionSource
        repeatedRuntimeMarkers = $_.repeatedRuntimeMarkers
        repeatedToolContractMarkers = $_.repeatedToolContractMarkers
        errorCount = $_.errors.Count
        deleted   = $_.deleted
        eventLines = $_.eventLines
      }
    })
  }
  $path = Join-Path $OutputDir "session-report-$ts.json"
  $report | ConvertTo-Json -Depth 5 | Out-File $path -Encoding UTF8
  Write-Host "`n[+] Report: $path" -ForegroundColor Green
}

if ($Strict -and $issues.Count -gt 0) {
  Write-Host "[ERROR] Strict audit rejected $($issues.Count) issue(s)." -ForegroundColor Red
  exit 2
}
