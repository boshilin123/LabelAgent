$ErrorActionPreference = 'Stop'

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frontend = Join-Path $workspace 'LR-Agent'
$localPython = Join-Path $workspace '.venvs\langchain-migration\Scripts\python.exe'
# The inference interpreter is currently reused read-only from the original
# installation; model/config caches and all application data remain isolated.
$inferencePython = 'D:\Study\LR-Agent\.venvs\lr-agent-inference\Scripts\python.exe'
$userData = Join-Path $workspace '.venvs\.runtime\migration-user-data'
$runtime = Join-Path $workspace '.venvs\.runtime'

foreach ($required in @($frontend, $localPython, $inferencePython)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing migration runtime path: $required"
    }
}

foreach ($port in @(1213, 18000)) {
    if ($port -eq 1213 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        throw "Migration renderer port $port is already in use."
    }
}

$backendHealth = Invoke-WebRequest -Uri 'http://127.0.0.1:18000/health' -UseBasicParsing -TimeoutSec 5
if ($backendHealth.StatusCode -ne 200) {
    throw 'Migration backend is not healthy on 127.0.0.1:18000.'
}

$env:PORT = '1213'
$env:LR_AGENT_DEV_HOST = '127.0.0.1'
$env:API_BASE_URL = 'http://127.0.0.1:18000/api/v1'
$env:LR_AGENT_USER_DATA_DIR = $userData
$env:LR_AGENT_LOCAL_PYTHON = $localPython
$env:LR_AGENT_INFERENCE_PYTHON = $inferencePython
$env:CORS_ORIGINS = '["http://127.0.0.1:1213","http://localhost:1213"]'
$env:YOLO_CONFIG_DIR = Join-Path $runtime 'ultralytics'
$env:MPLCONFIGDIR = Join-Path $runtime 'matplotlib'
$env:ELECTRON_CACHE = Join-Path $runtime 'cache\electron'
$env:ELECTRON_OVERRIDE_DIST_PATH = 'D:\Study\LR-Agent\LR-Agent\node_modules\electron\dist'

foreach ($dir in @($userData, $env:YOLO_CONFIG_DIR, $env:MPLCONFIGDIR, $env:ELECTRON_CACHE)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

Set-Location -LiteralPath $frontend
Write-Host 'Starting isolated migration desktop on 127.0.0.1:1213.'
Write-Host 'Keep this terminal open; press Ctrl+C to stop the desktop app.'
npm.cmd run dev
