param(
    [Parameter(Mandatory=$true)]
    [string]$Model,

    [string]$LogPath = ".\dev.log"
)

$scriptPath = Join-Path $PSScriptRoot "verify-opencode-long-conversation.ps1"

& $scriptPath `
    -Model $Model `
    -LogPath $LogPath `
    -PromptPath "tests/agent-capability/long-conversation-contamination.md"

exit $LASTEXITCODE
