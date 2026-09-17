$ErrorActionPreference = 'Stop'

$workspace = 'D:\Study\LR-Agent'
$runtime = Join-Path $workspace '.venvs\.runtime'
$frontend = Join-Path $workspace 'LR-Agent'
$backendDocker = Join-Path $workspace 'LR-Agent-backend\docker'
$localPython = Join-Path $workspace '.venvs\lr-agent-local\Scripts\python.exe'
$inferencePython = Join-Path $workspace '.venvs\lr-agent-inference\Scripts\python.exe'

foreach ($required in @($frontend, $backendDocker, $localPython, $inferencePython)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing required path: $required"
    }
}

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
