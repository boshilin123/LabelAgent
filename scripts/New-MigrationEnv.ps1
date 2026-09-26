$ErrorActionPreference = 'Stop'

# Secrets are generated locally; this script never prints or overwrites them.
$expectedRoot = [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')
$actualRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if (-not [string]::Equals($actualRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create credentials outside the migration copy: $actualRoot"
}

$target = Join-Path $actualRoot 'LR-Agent-backend\docker\.env.migration'
if (Test-Path -LiteralPath $target) {
    throw 'Migration credentials already exist; refusing to overwrite them.'
}

function New-RandomHex([int]$bytesCount) {
    $bytes = New-Object byte[] $bytesCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

$lines = @(
    '# Generated locally for the isolated migration stack. Never commit this file.'
    'POSTGRES_USER=lr_agent_migration'
    'POSTGRES_DB=lr_agent_migration'
    ('POSTGRES_PASSWORD=' + (New-RandomHex 32))
    ('REDIS_PASSWORD=' + (New-RandomHex 32))
    'MINIO_ROOT_USER=lragentmigration'
    ('MINIO_ROOT_PASSWORD=' + (New-RandomHex 32))
    ('SECRET_KEY=' + (New-RandomHex 48))
)

$encoding = New-Object System.Text.UTF8Encoding($false)
$text = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
$bytes = $encoding.GetBytes($text)
$stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $stream.Write($bytes, 0, $bytes.Length)
} finally {
    $stream.Dispose()
}

Write-Output "Created ignored credential file: $target"
Write-Output 'Credential values were not displayed.'
