<#
Installs Oak on Windows: Node.js (via winget, if missing), the repo, npm
deps, a default config, and a Scheduled Task that starts Oak at user logon
and restarts it if it crashes - Windows has no systemd/launchd, so this
uses Task Scheduler (built in, nothing extra to download or trust) with an
AtLogOn trigger, mirroring install-macos.sh's per-user LaunchAgent model
rather than a machine-wide service - it never needs Administrator either.

Safe to re-run - each step is skipped if already done, so this also works
as an update script (git pull + npm install + task restart) for an
existing install.

Usage:
  .\scripts\install-windows.ps1 [-Port 8702]
Or, if you don't have the repo yet:
  irm https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install-windows.ps1 | iex
#>
param(
    [int]$Port = 8702
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    Write-Error "This installer is for Windows specifically - use scripts/install.sh on Linux or scripts/install-macos.sh on macOS instead."
    exit 1
}

$RepoUrl    = "https://github.com/qinghuaatbc/oak.git"
$InstallDir = Join-Path $HOME "oak-app\oak"
$TaskName   = "OakOrchestrator"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "==> Node.js not found."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "==> Installing Node.js LTS via winget..."
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        # Refresh PATH in this session so the newly installed node is visible
        # without opening a new shell.
        $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machinePath;$userPath"
    } else {
        # Deliberately NOT installing winget itself - same trust-boundary
        # call install-macos.sh makes about Homebrew.
        Write-Error "winget isn't available, and this script won't install Node.js any other way for you.`nInstall Node.js yourself from https://nodejs.org, then re-run this script."
        exit 1
    }
} else {
    Write-Host "==> Node.js already installed ($(node -v)), skipping."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git isn't installed. Install it from https://git-scm.com, then re-run this script."
    exit 1
}

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "==> Oak already cloned at $InstallDir, pulling latest..."
    git -C $InstallDir pull
} else {
    Write-Host "==> Cloning Oak into $InstallDir..."
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
    git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir
Write-Host "==> Installing npm dependencies..."
npm install

$configPath    = Join-Path $InstallDir "orchestrator\config.json"
$configExample = Join-Path $InstallDir "orchestrator\config.example.json"
if (-not (Test-Path $configPath)) {
    Write-Host "==> Creating default config.json (empty - add driver instances from the admin UI)..."
    Copy-Item $configExample $configPath
} else {
    Write-Host "==> orchestrator\config.json already exists, leaving it alone."
}

# Scheduled Task actions can't set a per-task environment variable directly,
# unlike systemd's Environment= or launchd's EnvironmentVariables dict - so
# the port is baked into a small launcher script instead of the task itself.
$nodePath = (Get-Command node).Source
$launcher = Join-Path $InstallDir "oak-start.cmd"
@"
@echo off
cd /d "$InstallDir"
set PORT=$Port
"$nodePath" orchestrator\server.js >> oak.log 2>&1
"@ | Set-Content -Encoding ASCII $launcher

Write-Host "==> Registering scheduled task (port $Port)..."
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $InstallDir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Oak - independently-designed device-driver orchestrator" | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "==> Done."
Start-Sleep -Seconds 1
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.PrefixOrigin -eq "Dhcp" } |
       Select-Object -First 1 -ExpandProperty IPAddress)
if (-not $ip) { $ip = "<this-machine-ip>" }

Write-Host ""
Write-Host "Admin panel: http://${ip}:$Port/admin.html"
Write-Host "Live view:   http://${ip}:$Port/live.html"
Write-Host "Logs:        Get-Content `"$InstallDir\oak.log`" -Wait"
Write-Host "Stop:        Stop-ScheduledTask -TaskName $TaskName"
Write-Host "Start again: Start-ScheduledTask -TaskName $TaskName"
