# Agent Console — Windows System Tray
#
# A system-tray icon that aggregates agent health (by reading
# <repoRoot>/<AgentStateDir>/<role>/heartbeat.json) and exposes spawn / poke /
# pause / resume / open-console actions via right-click menu. Runs hidden.
#
# Launch:
#   pwsh -NoProfile -WindowStyle Hidden -File agent-tray.ps1 `
#       -RepoRoot C:/path/to/repo `
#       -Roles PrincipalEngineerAgent,SeniorEngineerAgent `
#       -SpawnScripts @{ PrincipalEngineerAgent = 'scripts/spawn-pe.ps1'; SeniorEngineerAgent = 'scripts/spawn-se.ps1' } `
#       -AgentControlScript scripts/agent.ps1
#
# Health icon mapping:
#   green — every registered role's heartbeat refreshed within -StaleSec
#   amber — at least one role stale OR no roles registered yet
#   red   — heartbeat reader failed entirely
#
# Designed to be repo-agnostic: all PP-specific paths are parameters.

[CmdletBinding()]
param(
    [int]$PollSec = 15,
    [int]$StaleSec = 180,
    [Parameter(Mandatory)] [string]$RepoRoot,
    [string]$AgentStateDir = '.agent',
    [string[]]$Roles = @(),
    [hashtable]$SpawnScripts = @{},
    [string]$AgentControlScript,
    [string]$OrchestratorLog,
    [string]$OpenConsoleCommand = 'agentConsole.openConsole',
    [string]$AppLabel = 'Agent Console'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:RepoRoot           = (Resolve-Path $RepoRoot).Path
$script:AgentStateDir      = $AgentStateDir
$script:Roles              = $Roles
$script:SpawnScripts       = $SpawnScripts
$script:AgentControlScript = $AgentControlScript
$script:OrchestratorLog    = if ($OrchestratorLog) { $OrchestratorLog } else { Join-Path $AgentStateDir 'orchestrator.log' }
$script:OpenConsoleCommand = $OpenConsoleCommand
$script:AppLabel           = $AppLabel
$script:Icon               = $null
$script:Menu               = $null
$script:Timer              = $null

function Get-AgentHealth {
    $stateDir = Join-Path $script:RepoRoot $script:AgentStateDir
    if (-not (Test-Path $stateDir)) { return @{ overall = 'amber'; roles = @() } }

    $now = [DateTime]::UtcNow
    $entries = @()
    foreach ($role in $script:Roles) {
        $hb = Join-Path $stateDir "$role/heartbeat.json"
        if (-not (Test-Path $hb)) {
            $entries += [pscustomobject]@{ role = $role; status = 'unknown'; ageSec = -1; healthy = $false }
            continue
        }
        try {
            $obj = Get-Content -Raw $hb | ConvertFrom-Json
            $ts  = [DateTime]::Parse($obj.ts).ToUniversalTime()
            $age = [int]($now - $ts).TotalSeconds
            $entries += [pscustomobject]@{
                role    = $role
                status  = $obj.status
                ageSec  = $age
                healthy = ($age -le $StaleSec)
            }
        } catch {
            $entries += [pscustomobject]@{ role = $role; status = 'parse-error'; ageSec = -1; healthy = $false }
        }
    }
    $overall = if ($entries.Count -eq 0) { 'amber' }
               elseif ($entries | Where-Object { -not $_.healthy }) { 'amber' }
               else { 'green' }
    return @{ overall = $overall; roles = $entries }
}

function New-StatusIcon {
    param([string]$Color)
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = switch ($Color) {
        'green' { [System.Drawing.Brushes]::LimeGreen }
        'amber' { [System.Drawing.Brushes]::Orange }
        'red'   { [System.Drawing.Brushes]::Crimson }
        default { [System.Drawing.Brushes]::Gray }
    }
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $g.DrawEllipse([System.Drawing.Pens]::Black, 1, 1, 14, 14)
    $g.Dispose()
    $hicon = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hicon)
}

function Invoke-Pwsh {
    param([string]$ScriptPath, [string[]]$Args)
    if (-not $ScriptPath) { return }
    $full = if ([System.IO.Path]::IsPathRooted($ScriptPath)) { $ScriptPath } else { Join-Path $script:RepoRoot $ScriptPath }
    if (-not (Test-Path $full)) {
        [System.Windows.Forms.MessageBox]::Show("Missing script: $ScriptPath") | Out-Null
        return
    }
    $argList = @('-NoProfile','-File',"`"$full`"") + $Args
    Start-Process -FilePath 'pwsh' -ArgumentList $argList -WindowStyle Hidden | Out-Null
}

function Open-AgentConsole {
    $exe = (Get-Command code-insiders -ErrorAction SilentlyContinue)?.Source
    if (-not $exe) { $exe = (Get-Command code -ErrorAction SilentlyContinue)?.Source }
    if (-not $exe) {
        [System.Windows.Forms.MessageBox]::Show("VS Code not on PATH") | Out-Null
        return
    }
    Start-Process -FilePath $exe -ArgumentList @('--command', $script:OpenConsoleCommand) -WindowStyle Hidden | Out-Null
}

function Build-Menu {
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $health = Get-AgentHealth
    $headerText = "Health: $($health.overall.ToUpper())"
    $headerItem = $menu.Items.Add($headerText); $headerItem.Enabled = $false

    foreach ($r in $health.roles) {
        $age = if ($r.ageSec -ge 0) { "$($r.ageSec)s ago" } else { 'no heartbeat' }
        $rowItem = $menu.Items.Add("  $($r.role): $($r.status) ($age)")
        $rowItem.Enabled = $false
    }
    $menu.Items.Add('-') | Out-Null

    $openConsole = $menu.Items.Add('Open Agent Console')
    $openConsole.Add_Click({ Open-AgentConsole })

    if ($script:AgentControlScript) {
        $menu.Items.Add('-') | Out-Null
        $pauseAll = $menu.Items.Add('Pause All Agents')
        $pauseAll.Add_Click({ Invoke-Pwsh $script:AgentControlScript @('pause','all') })
        $resumeAll = $menu.Items.Add('Resume All Agents')
        $resumeAll.Add_Click({ Invoke-Pwsh $script:AgentControlScript @('resume','all') })
    }

    if ($script:SpawnScripts.Count -gt 0) {
        $menu.Items.Add('-') | Out-Null
        $spawnSubmenu = New-Object System.Windows.Forms.ToolStripMenuItem 'Spawn'
        $pokeSubmenu  = New-Object System.Windows.Forms.ToolStripMenuItem 'Poke'
        foreach ($role in $script:Roles) {
            $scriptPath = $script:SpawnScripts[$role]
            if (-not $scriptPath) { continue }
            $sItem = $spawnSubmenu.DropDownItems.Add($role); $sItem.Tag = $scriptPath
            $sItem.Add_Click({ param($s,$e) Invoke-Pwsh $s.Tag @() })
            $pItem = $pokeSubmenu.DropDownItems.Add($role); $pItem.Tag = $scriptPath
            $pItem.Add_Click({ param($s,$e) Invoke-Pwsh $s.Tag @('-Poke') })
        }
        $menu.Items.Add($spawnSubmenu) | Out-Null
        $menu.Items.Add($pokeSubmenu)  | Out-Null
    }

    $menu.Items.Add('-') | Out-Null
    $orchStatus = $menu.Items.Add('Orchestrator Log')
    $orchStatus.Add_Click({
        $logFile = if ([System.IO.Path]::IsPathRooted($script:OrchestratorLog)) { $script:OrchestratorLog } else { Join-Path $script:RepoRoot $script:OrchestratorLog }
        if (Test-Path $logFile) { Start-Process notepad.exe $logFile }
        else { [System.Windows.Forms.MessageBox]::Show("Orchestrator log not found at $logFile") | Out-Null }
    })

    $menu.Items.Add('-') | Out-Null
    $quit = $menu.Items.Add('Quit')
    $quit.Add_Click({
        if ($script:Icon)  { $script:Icon.Visible = $false; $script:Icon.Dispose() }
        if ($script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() }
        [System.Windows.Forms.Application]::Exit()
    })

    return $menu
}

function Refresh-Tray {
    $health = Get-AgentHealth
    $newIcon = New-StatusIcon -Color $health.overall
    $oldIcon = $script:Icon.Icon
    $script:Icon.Icon = $newIcon
    if ($oldIcon) { $oldIcon.Dispose() }
    $script:Icon.Text = "$($script:AppLabel) - $($health.overall.ToUpper())"
    $script:Icon.ContextMenuStrip = Build-Menu
}

function Initialize-Tray {
    $script:Icon = New-Object System.Windows.Forms.NotifyIcon
    $script:Icon.Visible = $true
    Refresh-Tray

    $script:Timer = New-Object System.Windows.Forms.Timer
    $script:Timer.Interval = $PollSec * 1000
    $script:Timer.Add_Tick({ Refresh-Tray })
    $script:Timer.Start()
}

try {
    Initialize-Tray
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($script:Icon)  { $script:Icon.Visible = $false; $script:Icon.Dispose() }
    if ($script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() }
}
