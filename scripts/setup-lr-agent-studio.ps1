$ErrorActionPreference = 'Stop'

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePython = Join-Path $workspace '.venvs\langchain-main\Scripts\python.exe'
$studioRoot = Join-Path $workspace '.venvs\langchain-studio'
$studioPython = Join-Path $studioRoot 'Scripts\python.exe'
$requirements = Join-Path $workspace 'LR-Agent\vendor\local-agent\requirements.txt'

if (-not (Test-Path -LiteralPath $sourcePython -PathType Leaf)) {
    throw "Missing LangChain Python environment: $sourcePython"
}
if (-not (Test-Path -LiteralPath $studioPython -PathType Leaf)) {
    & $sourcePython -m venv $studioRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create isolated Studio environment.' }
}

& $studioPython -m pip install --disable-pip-version-check -r $requirements 'langgraph-cli[inmem]==0.4.32'
if ($LASTEXITCODE -ne 0) { throw 'Failed to install Studio dependencies.' }
& $studioPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Studio dependency check failed.' }
Write-Host 'Studio environment is ready.'
