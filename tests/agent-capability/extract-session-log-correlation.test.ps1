param()

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

function Fail([string]$Message) {
  Write-Host "[FAIL] $Message"
  exit 1
}

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("chat2api-session-log-test-" + [Guid]::NewGuid().ToString("N"))
$logPath = Join-Path $tmpRoot "dev.log"
$outDir = Join-Path $tmpRoot "reports"
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

try {
  @(
    '[Forwarder] Tool transform trace: {"correlationId":"req-a","requestId":"req-a","providerId":"qwen","model":"qwen/test","toolSessionKeyPresent":true,"inputMessageCount":2,"outputMessageCount":3,"inputToolsPresent":true,"outputToolsPresent":false,"planMode":"managed","catalogSource":"request_tools","catalogFingerprint":"fp-a","toolCount":1,"injected":true}',
    '[Forwarder] Runtime pilot request trace: {"correlationId":"req-a","requestId":"req-a","providerId":"qwen","sessionBoundaryReason":"normal","toolSessionKeyPresent":true,"providerConversationSessionKeyIsChild":false,"parentProviderConversationSessionKeyPresent":false,"promptRefreshMode":"full"}',
    '[Forwarder] Runtime pilot request trace: {"providerId":"qwen","sessionBoundaryReason":"client_compact","toolSessionKeyPresent":false,"providerConversationSessionKeyIsChild":false,"parentProviderConversationSessionKeyPresent":false,"promptRefreshMode":"delta"}',
    '[ProviderRuntime] Context economy: {"correlationId":"req-a","requestId":"req-a","providerPlugin":"qwen","assemblyMessageCount":3,"assemblyToolContractChars":100,"assemblyActionConstraint":null,"contextEconomy":{"repeatedRuntimeConfigMarkers":0,"repeatedToolContractMarkers":0},"rawAssemblyChars":200,"cleanedPromptChars":150,"providerSessionAction":"reuse_parent","providerSessionIdSource":"state"}'
  ) | Set-Content -Path $logPath -Encoding UTF8

  $global:LASTEXITCODE = 0
  & .\scripts\extract-session-log.ps1 -LogPath $logPath -OutputDir $outDir -Strict | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "extract-session-log.ps1 failed" }

  $report = Get-ChildItem -Path $outDir -Filter "session-report-*.json" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $report) { Fail "report was not created" }

  $json = Get-Content -Raw $report.FullName | ConvertFrom-Json
  if ($json.sessionCount -ne 2) { Fail "expected 2 sessions, got $($json.sessionCount)" }

  $withId = @($json.sessions | Where-Object { $_.requestId -eq "req-a" })
  if ($withId.Count -ne 1) { Fail "expected exactly one req-a session, got $($withId.Count)" }
  if ($withId[0].toolPlan -ne "managed") { Fail "req-a tool transform was not attached to req-a" }
  if ($withId[0].providerAction -ne "reuse_parent") { Fail "req-a runtime economy was not attached to req-a" }

  $unknown = @($json.sessions | Where-Object { $_.requestId -eq "unknown" })
  if ($unknown.Count -ne 1) { Fail "expected exactly one unknown session, got $($unknown.Count)" }
  if ($unknown[0].providerAction -ne "") { Fail "unknown session received req-a runtime economy, indicating mismatch" }

  Write-Host "[PASS] extract-session-log correlation parser regression passed"
} finally {
  if (Test-Path $tmpRoot) {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force
  }
}
