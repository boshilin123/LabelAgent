$ErrorActionPreference = 'Stop'

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$expected = [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')
if (-not [string]::Equals($workspace, $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to start outside the migration copy: $workspace"
}

$containerLauncher = Join-Path $PSScriptRoot 'start-migration-containers.ps1'
$desktopLauncher = Join-Path $PSScriptRoot 'start-migration-desktop.ps1'
foreach ($launcher in @($containerLauncher, $desktopLauncher)) {
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Missing migration launcher: $launcher"
    }
}

if (Get-NetTCPConnection -LocalPort 1213 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Migration desktop is already running on port 1213. Stop it before launching another copy.'
}

Write-Host '[1/3] Starting migration containers...'
& $containerLauncher
if ($LASTEXITCODE -ne 0) {
    throw "Migration container launcher failed with exit code $LASTEXITCODE."
}

Write-Host '[2/3] Waiting for migration API health...'
$healthy = $false
for ($attempt = 1; $attempt -le 45; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18000/health' -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $healthy) {
    throw 'Migration API did not become healthy on 127.0.0.1:18000 within 90 seconds.'
}

Write-Host '[3/3] Starting migration desktop...'
& $desktopLauncher
if ($LASTEXITCODE -ne 0) {
    throw "Migration desktop exited with code $LASTEXITCODE."
}
