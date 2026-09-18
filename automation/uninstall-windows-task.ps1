$ErrorActionPreference = 'Stop'
$taskName = 'CareerOpsLocalAutomation'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed $taskName."
} else {
  Write-Output "$taskName is not installed."
}
