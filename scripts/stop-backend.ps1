$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\') -eq
    [IO.Path]::GetFullPath('D:\Study\LR-Agent-LangChain-Migration').TrimEnd('\')) {
    throw 'Legacy stop script targets the original project. Use scripts\stop-migration-containers.ps1.'
}
Set-Location 'D:\Study\LR-Agent\LR-Agent-backend\docker'
docker compose stop
