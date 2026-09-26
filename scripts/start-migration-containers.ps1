$ErrorActionPreference = 'Stop'

$expectedRoot = [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')
$actualRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if (-not [string]::Equals($actualRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to start containers outside the migration copy: $actualRoot"
}

$dockerDir = Join-Path $actualRoot 'LR-Agent-backend\docker'
$envFile = Join-Path $dockerDir '.env.migration'
$composeFile = Join-Path $dockerDir 'docker-compose.migration.yml'
if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Missing .env.migration. Run scripts\New-MigrationEnv.ps1 once.'
}
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw 'Missing docker-compose.migration.yml.'
}

docker info | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not ready.' }

Push-Location $dockerDir
try {
    docker compose --env-file .env.migration -f docker-compose.migration.yml config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Migration Compose validation failed.' }
    docker compose --env-file .env.migration -f docker-compose.migration.yml up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Migration container startup failed.' }
    docker compose --env-file .env.migration -f docker-compose.migration.yml ps
} finally {
    Pop-Location
}
