# Install Windows Startup shortcut for Agent Console's tray.
#
# Creates a .lnk in the user's Startup folder that launches the tray hidden.
# Re-running replaces the shortcut (idempotent).
#
# Example:
#   pwsh -NoProfile -File install-tray.ps1 `
#       -RepoRoot C:/path/to/repo `
#       -Roles PrincipalEngineerAgent,SeniorEngineerAgent `
#       -SpawnScripts '{"PrincipalEngineerAgent":"scripts/spawn-pe.ps1","SeniorEngineerAgent":"scripts/spawn-se.ps1"}'

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [Parameter(Mandatory = $false)] [string]$RepoRoot,
    [string[]]$Roles = @(),
    [string]$SpawnScripts,
    [string]$AgentControlScript,
    [string]$AgentStateDir = '.agent',
    [string]$AppLabel = 'Agent Console'
)

$startup      = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup "$AppLabel Tray.lnk"

if ($Uninstall) {
    if (Test-Path $shortcutPath) {
        Remove-Item -Force $shortcutPath
        Write-Host "Removed: $shortcutPath" -ForegroundColor Green
    } else {
        Write-Host "Nothing to remove." -ForegroundColor Yellow
    }
    return
}

if (-not $RepoRoot) { throw "-RepoRoot is required when installing." }

$trayScript = Join-Path $PSScriptRoot 'agent-tray.ps1'
if (-not (Test-Path $trayScript)) { throw "tray script not found: $trayScript" }

$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwshExe) { throw "pwsh.exe not on PATH; install PowerShell 7+" }

$args = @('-NoProfile','-WindowStyle','Hidden','-File',"`"$trayScript`"",'-RepoRoot',"`"$RepoRoot`"",'-AgentStateDir',"`"$AgentStateDir`"",'-AppLabel',"`"$AppLabel`"")
if ($Roles.Count -gt 0) { $args += '-Roles'; $args += ($Roles -join ',') }
if ($AgentControlScript) { $args += '-AgentControlScript'; $args += "`"$AgentControlScript`"" }
if ($SpawnScripts) {
    $args += '-SpawnScripts'
    # Pass the hashtable as an inline PS expression so the launcher rehydrates it.
    $args += "`"$SpawnScripts`""
}

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcutPath)
$lnk.TargetPath       = $pwshExe
$lnk.Arguments        = ($args -join ' ')
$lnk.WorkingDirectory = $RepoRoot
$lnk.IconLocation     = "$pwshExe,0"
$lnk.Description      = "$AppLabel tray launcher"
$lnk.WindowStyle      = 7
$lnk.Save()

Write-Host "Installed: $shortcutPath" -ForegroundColor Green
Write-Host "Launching tray now..." -ForegroundColor Cyan
Start-Process -FilePath $pwshExe -ArgumentList $args -WindowStyle Hidden | Out-Null
