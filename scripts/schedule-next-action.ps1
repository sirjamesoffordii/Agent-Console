# Agent Console — next-prompt / respawn-ETA scheduler
#
# Consumes each role's cadence from roles.json and writes:
#   <agentStateDir>/<role>/next-prompt.json   — preview of the next prompt
#   <agentStateDir>/<role>/next-action.json   — planned action + ETA epoch
#
# Schedule via Task Scheduler every minute, or run `-Watch`.

[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$RolesFile = '.github/agents/roles.json',
    [string]$AgentStateDir = '.agent',
    [switch]$Watch,
    [int]$WatchIntervalSec = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

Import-Module (Join-Path $RepoRoot 'tools/agent-contract/agent-contract.psm1') -Force

function Read-Roles {
    param([string]$RepoRoot, [string]$RolesFile)
    $file = if ([System.IO.Path]::IsPathRooted($RolesFile)) { $RolesFile } else { Join-Path $RepoRoot $RolesFile }
    if (-not (Test-Path $file)) { return @() }
    $doc = Get-Content -Raw $file | ConvertFrom-Json
    return @($doc.roles)
}

function Get-DefaultPrompt {
    param([pscustomobject]$Role)
    switch ($Role.id) {
        'PrincipalEngineerAgent' { return 'Resume the Principal Engineer loop.' }
        'SeniorEngineerAgent'    { return 'Resume the Senior Engineer loop: pick next Todo, critique, implement, test.' }
        'QualityAssuranceAgent'  { return 'Run the next QA persona lane and file findings.' }
        'ProductDesignAgent'     { return 'Audit recent UI/UX surfaces for usability and file design-only issues.' }
        default                  { return "Resume the $($Role.displayName) loop." }
    }
}

function Get-PlannedDelaySec {
    param([pscustomobject]$Role)
    switch -Wildcard ($Role.cadence) {
        'continuous'                   { return 60 }          # ~1 min between ticks
        'scheduled:persona-rotation'   { return 3600 }        # 1 hr
        'scheduled:daily'              { return 24 * 3600 }
        'scheduled:weekly'             { return 7 * 24 * 3600 }
        'manual'                       { return $null }       # no auto-respawn
        default                        { return 900 }         # 15 min safe default
    }
}

function Plan-Action {
    param([pscustomobject]$Role, [string]$StateDir)

    $delay = Get-PlannedDelaySec -Role $Role
    if ($null -eq $delay) {
        Write-AgentNextAction -RepoRoot $RepoRoot -Role $Role.id `
            -Action 'none' -Reason 'cadence=manual' | Out-Null
        return
    }

    # Default action: poke (re-kick chat) if window likely open, otherwise spawn.
    # We don't probe windows here — the tray/console already do that. Instead we
    # pick 'spawn' for the first launch of the cycle and let the console/tray
    # downgrade to 'poke' when the window is detected.
    $heartbeatFile = Join-Path $StateDir (Join-Path $Role.id 'heartbeat.json')
    $action = 'spawn'
    if (Test-Path $heartbeatFile) {
        try {
            $hb = Get-Content -Raw $heartbeatFile | ConvertFrom-Json
            $age = ([DateTime]::UtcNow - [DateTime]::Parse($hb.ts).ToUniversalTime()).TotalSeconds
            if ($age -le 300) { $action = 'poke' }
        } catch { }
    }

    $planned = [int][double]::Parse((Get-Date -UFormat %s)) + $delay

    Write-AgentNextPrompt -RepoRoot $RepoRoot -Role $Role.id `
        -Prompt (Get-DefaultPrompt -Role $Role) `
        -Reason "cadence=$($Role.cadence)" `
        -PlannedAtEpoch $planned | Out-Null

    Write-AgentNextAction -RepoRoot $RepoRoot -Role $Role.id `
        -Action $action -Reason "cadence=$($Role.cadence)" `
        -PlannedAtEpoch $planned | Out-Null

    Write-Host "[$($Role.id)] action=$action in ${delay}s (ETA epoch=$planned)" -ForegroundColor Cyan
}

function Invoke-Once {
    $stateDir = Join-Path $RepoRoot $AgentStateDir
    if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    $roles = Read-Roles -RepoRoot $RepoRoot -RolesFile $RolesFile
    if ($roles.Count -eq 0) {
        Write-Warning "No roles found in $RolesFile"
        return
    }
    foreach ($role in $roles) {
        Plan-Action -Role $role -StateDir $stateDir
    }
}

if ($Watch) {
    Write-Host "planning next actions every ${WatchIntervalSec}s (Ctrl+C to stop)" -ForegroundColor Green
    while ($true) {
        Invoke-Once
        Start-Sleep -Seconds $WatchIntervalSec
    }
} else {
    Invoke-Once
}
