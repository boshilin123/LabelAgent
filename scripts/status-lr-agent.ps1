$ErrorActionPreference = 'Continue'

Write-Host '=== Backend containers ==='
Push-Location 'D:\Study\LR-Agent\LR-Agent-backend\docker'
docker compose ps
Pop-Location

Write-Host "`n=== Health endpoints ==="
try {
    $backend = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 5
    Write-Host "Backend: $($backend.status)"
} catch {
    Write-Host "Backend: unavailable ($($_.Exception.Message))"
}

$localAgentProcesses = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'python.exe' -and
            $_.CommandLine -like '*vendor\local-agent\local_main.py*'
        }
)
$localAgentPorts = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -in $localAgentProcesses.ProcessId } |
        Select-Object -ExpandProperty LocalPort -Unique
)
if ($localAgentPorts.Count -eq 0) {
    Write-Host 'Local agent: not running'
} else {
    foreach ($port in $localAgentPorts) {
        try {
            $localAgent = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
            Write-Host "Local agent: $($localAgent.status) (port $port)"
        } catch {
            Write-Host "Local agent: listener found on port $port, health unavailable"
        }
    }
}

Write-Host "`n=== Electron ==="
Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like 'D:\Study\LR-Agent\LR-Agent\*' } |
    Select-Object Id, MainWindowTitle, Path |
    Format-Table -AutoSize

Write-Host "`n=== Relevant listening ports ==="
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object {
        $_.LocalPort -in 1212, 8000, 5432, 6379, 9000, 9001, 8765 -or
        $_.OwningProcess -in $localAgentProcesses.ProcessId
    } |
    Select-Object LocalAddress, LocalPort, OwningProcess |
    Sort-Object LocalPort |
    Format-Table -AutoSize
