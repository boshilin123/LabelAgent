$ErrorActionPreference = 'Stop'

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $workspace '.venvs\.runtime'
$studioCli = Join-Path $workspace '.venvs\langchain-studio\Scripts\langgraph.exe'
$agentRoot = Join-Path $workspace 'LR-Agent\vendor\local-agent'
$langsmithKeyFile = Join-Path $runtime 'langsmith-api-key.txt'
$modelConfigFile = Join-Path $runtime 'studio-model.env'
$studioPort = 2025

if (-not (Test-Path -LiteralPath $studioCli -PathType Leaf)) {
    throw "Studio CLI is missing. Run scripts\setup-lr-agent-studio.ps1 first."
}
if (-not (Test-Path -LiteralPath $langsmithKeyFile -PathType Leaf)) {
    throw "LangSmith API key is missing: $langsmithKeyFile"
}
if (Get-NetTCPConnection -LocalPort $studioPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Studio port $studioPort is already in use; refusing to connect to another project's graph."
}

$langsmithKey = (Get-Content -LiteralPath $langsmithKeyFile -Raw).Trim()
if ($langsmithKey -notmatch '^lsv2_[A-Za-z0-9_]+$') {
    throw 'Invalid LangSmith API key format.'
}
$env:LANGSMITH_API_KEY = $langsmithKey
$env:LANGSMITH_TRACING = 'true'
$env:LANGSMITH_PROJECT = 'lr-agent-studio'
Remove-Variable langsmithKey

$env:LR_AGENT_STUDIO_WORKSPACE_ROOT = $workspace
Remove-Item Env:LR_AGENT_STUDIO_MODEL, Env:LR_AGENT_STUDIO_BASE_URL, Env:LR_AGENT_STUDIO_MODEL_API_KEY -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $modelConfigFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $modelConfigFile) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed.Split('=', 2)
        if ($parts.Count -ne 2 -or $parts[0] -notin @('LR_AGENT_STUDIO_MODEL', 'LR_AGENT_STUDIO_BASE_URL', 'LR_AGENT_STUDIO_MODEL_API_KEY', 'LR_AGENT_STUDIO_WORKSPACE_ROOT')) {
            throw "Invalid Studio setting in $modelConfigFile"
        }
        [Environment]::SetEnvironmentVariable($parts[0], $parts[1].Trim(), 'Process')
    }
}

if (-not ($env:LR_AGENT_STUDIO_MODEL -and $env:LR_AGENT_STUDIO_BASE_URL -and $env:LR_AGENT_STUDIO_MODEL_API_KEY)) {
    Write-Warning 'Studio is in graph-preview mode. Configure studio-model.env before running model calls.'
}

Write-Host "Studio URL: https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:$studioPort"
Push-Location $agentRoot
try {
    & $studioCli dev --config langgraph.json --host 127.0.0.1 --port $studioPort
} finally {
    Pop-Location
}
