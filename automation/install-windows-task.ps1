$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-local.ps1'
$taskName = 'CareerOpsLocalAutomation'
$powerShell = (Get-Command powershell.exe).Source
$quotedRunner = '"{0}"' -f $runner
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedRunner" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Runs career-ops locally; internal scheduler scans at 07:30 and sends the digest at 20:00 Asia/Singapore.' -Force | Out-Null
$installed = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($installed.Actions.Execute -ne $powerShell -or $installed.Actions.WorkingDirectory -ne $projectRoot) {
  throw "Task $taskName was registered with an unexpected action or working directory."
}
Write-Output "Installed $taskName. It will start at your next sign-in."
Write-Output "Start now: Start-ScheduledTask -TaskName '$taskName'"
Write-Output "Logs: $projectRoot\data\automation-logs"
