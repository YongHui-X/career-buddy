$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot 'data\automation-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logFile = Join-Path $logDirectory ("local-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
Set-Location -LiteralPath $projectRoot
& npm.cmd run automation:local *>> $logFile
exit $LASTEXITCODE
