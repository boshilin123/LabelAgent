$ErrorActionPreference = 'Stop'

$expectedRoot = [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')
$actualRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if (-not [string]::Equals($actualRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stop containers outside the migration copy: $actualRoot"
}

$dockerDir = Join-Path $actualRoot 'LR-Agent-backend\docker'
Push-Location $dockerDir
try {
    # Stop only the migration project. Keep all volumes and the original stack.
    docker compose --env-file .env.migration -f docker-compose.migration.yml stop
    if ($LASTEXITCODE -ne 0) { throw 'Migration container stop failed.' }
} finally {
    Pop-Location
}
