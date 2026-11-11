# Removes Oak's scheduled task on Windows (OakOrchestrator, as
# install-windows.ps1 sets it up) and stops Oak. The install folder
# ~\oak-app\oak stays - code, login (orchestrator\admin.json) and devices
# (orchestrator\config.json) - so installing again carries on where it left
# off; -Purge (or $env:OAK_PURGE = 1) deletes it too.
#
# Usage:
#   .\scripts\uninstall-windows.ps1 [-Purge]
# Or, without the repo at hand:
#   irm https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/uninstall-windows.ps1 | iex
#   $env:OAK_PURGE = 1; irm https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/uninstall-windows.ps1 | iex
#
# (The download version, oak-rs, is separate: oak-server.exe uninstall.)
param([switch]$Purge)
$ErrorActionPreference = "Stop"
if ($env:OAK_PURGE -eq "1") { $Purge = $true }

$TaskName   = "OakOrchestrator"
$InstallDir = Join-Path $HOME "oak-app\oak"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
# The task runs oak-start.cmd, which runs node: stopping the task can leave
# node running, so Oak's own node process is stopped by its command line.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*orchestrator\server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "==> Oak's scheduled task is removed and Oak is stopped."

if ($Purge) {
    Start-Sleep -Seconds 1 # (let node let go of oak.log)
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    $parent = Split-Path $InstallDir
    if ((Test-Path $parent) -and -not (Get-ChildItem $parent)) { Remove-Item $parent }
    Write-Host "==> Removed $InstallDir (code, login, devices)."
} elseif (Test-Path $InstallDir) {
    Write-Host "==> Kept $InstallDir - your login and devices are still there for a later install."
    Write-Host "    To delete it too: run this again with -Purge (or `$env:OAK_PURGE = 1)."
}
Write-Host "    (Node.js itself stays installed.)"
