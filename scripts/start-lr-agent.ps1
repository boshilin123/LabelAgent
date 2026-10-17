[CmdletBinding()]
param(
    [switch]$DisableTracing
)

$ErrorActionPreference = 'Stop'

# This copied legacy launcher hardcodes D:\Study\LR-Agent below. Fail closed
# inside the migration copy; use start-migration-containers.ps1 instead.
if ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\') -eq
    [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')) {
    throw 'Legacy launcher points to the original project. Use scripts\start-migration-containers.ps1 for the isolated stack.'
}

$workspace = 'D:\Study\LR-Agent'
$runtime = Join-Path $workspace '.venvs\.runtime'
$frontend = Join-Path $workspace 'LR-Agent'
$backendDocker = Join-Path $workspace 'LR-Agent-backend\docker'
$localPython = Join-Path $workspace '.venvs\langchain-main\Scripts\python.exe'
$inferencePython = Join-Path $workspace '.venvs\lr-agent-inference\Scripts\python.exe'

foreach ($required in @($frontend, $backendDocker, $localPython, $inferencePython)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing required path: $required"
    }
}

# Tracing is optional. Preserve existing local tracing without making a key
# a prerequisite for the desktop and Agent.
$langsmithKeyFile = Join-Path $runtime 'langsmith-api-key.txt'
$langsmithKey = $env:LANGSMITH_API_KEY
if (-not $DisableTracing -and [string]::IsNullOrWhiteSpace($langsmithKey) -and
    (Test-Path -LiteralPath $langsmithKeyFile -PathType Leaf)) {
    $langsmithKey = (Get-Content -LiteralPath $langsmithKeyFile -Raw).Trim()
}
if (-not $DisableTracing -and $langsmithKey -match '^lsv2_[A-Za-z0-9_]+$') {
    $env:LANGSMITH_API_KEY = $langsmithKey
    $env:LANGSMITH_TRACING = 'true'
    if ([string]::IsNullOrWhiteSpace($env:LANGSMITH_PROJECT)) {
        $env:LANGSMITH_PROJECT = 'lr-agent-local'
    }
    Write-Host "LangSmith tracing enabled for project: $env:LANGSMITH_PROJECT"
} else {
    $env:LANGSMITH_TRACING = 'false'
    if (-not $DisableTracing -and -not [string]::IsNullOrWhiteSpace($langsmithKey)) {
        Write-Warning 'Invalid LangSmith key format; tracing is disabled for this launch.'
    }
    Write-Host 'LangSmith tracing disabled; core Agent functions remain available.'
}
Remove-Variable langsmithKey

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is not ready. Start Docker Desktop and try again.'
}

Push-Location $backendDocker
try {
    docker compose up -d --no-build
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start backend containers.' }
} finally {
    Pop-Location
}

$env:LR_AGENT_LOCAL_PYTHON = $localPython
$env:AGENT_ENGINE = 'candidate'
$env:LR_AGENT_INFERENCE_PYTHON = $inferencePython
$env:API_BASE_URL = 'http://localhost:8000/api/v1'
$env:ELECTRON_CACHE = Join-Path $runtime 'cache\electron'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:YOLO_CONFIG_DIR = Join-Path $runtime 'ultralytics'
$env:MPLCONFIGDIR = Join-Path $runtime 'matplotlib'
New-Item -ItemType Directory -Path $env:ELECTRON_CACHE -Force | Out-Null
New-Item -ItemType Directory -Path $env:YOLO_CONFIG_DIR -Force | Out-Null
New-Item -ItemType Directory -Path $env:MPLCONFIGDIR -Force | Out-Null

Set-Location $frontend
Write-Host 'Starting LR-Agent. Keep this window open; press Ctrl+C to stop the desktop app.'
npm.cmd run dev
