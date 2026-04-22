# Agent Console — daily metrics rollup
#
# For each role in roles.json, reads the last N hours of activity.jsonl and
# writes <agentStateDir>/<role>/metrics-daily.json with event-type counts.
# Intended to be scheduled hourly or as part of a nightly rotation so the
# operator can spot regressions ("PE error rate tripled today").
#
# Schema:
#   {
#     role: string,
#     ts: iso,
#     windowHours: int,
#     startedFrom: iso,
#     totalEvents: int,
#     counts: {
#       "chat.turn.start": int, "chat.turn.end": int,
#       "tool.call": int, "command.run": int,
#       "error": int, "state.tick": int
#     },
#     lastError: string | null,
#     lastErrorTs: iso | null
#   }

[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$RolesFile = '.github/agents/roles.json',
    [string]$AgentStateDir = '.agent',
    [int]$WindowHours = 24
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Read-Roles {
    param([string]$RepoRoot, [string]$RolesFile)
    $file = if ([System.IO.Path]::IsPathRooted($RolesFile)) { $RolesFile } else { Join-Path $RepoRoot $RolesFile }
    if (-not (Test-Path $file)) { return @() }
    $doc = Get-Content -Raw $file | ConvertFrom-Json
    return @($doc.roles)
}

function Get-RoleMetrics {
    param(
        [Parameter(Mandatory)] [pscustomobject]$Role,
        [Parameter(Mandatory)] [string]$StateDir,
        [int]$WindowHours
    )
    $dir = Join-Path $StateDir $Role.id
    $activityFile = Join-Path $dir 'activity.jsonl'
    $metricsFile  = Join-Path $dir 'metrics-daily.json'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $now = [DateTime]::UtcNow
    $cutoff = $now.AddHours(-$WindowHours)

    $counts = [ordered]@{
        'chat.turn.start' = 0
        'chat.turn.end'   = 0
        'tool.call'       = 0
        'command.run'     = 0
        'error'           = 0
        'state.tick'      = 0
    }
    $total = 0
    $lastError    = $null
    $lastErrorTs  = $null

    if (Test-Path $activityFile) {
        foreach ($line in Get-Content $activityFile) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $e = $line | ConvertFrom-Json
            } catch { continue }
            if (-not $e.ts) { continue }
            try {
                $ts = [DateTime]::Parse($e.ts).ToUniversalTime()
            } catch { continue }
            if ($ts -lt $cutoff) { continue }
            $total++
            $t = $e.type
            if ($t -and $counts.Contains($t)) { $counts[$t]++ }
            if ($t -eq 'error') {
                $lastError   = $e.summary
                $lastErrorTs = $e.ts
            }
        }
    }

    $payload = [ordered]@{
        role         = $Role.id
        ts           = $now.ToString('o')
        windowHours  = $WindowHours
        startedFrom  = $cutoff.ToString('o')
        totalEvents  = $total
        counts       = $counts
        lastError    = $lastError
        lastErrorTs  = $lastErrorTs
        version      = 1
    }
    $tmp = $metricsFile + '.tmp'
    ($payload | ConvertTo-Json -Depth 5) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Force -Path $tmp -Destination $metricsFile

    $errCount = $counts['error']
    Write-Host ("[{0}] total={1} errors={2} turns={3}/{4}" -f $Role.id, $total, $errCount, $counts['chat.turn.start'], $counts['chat.turn.end']) -ForegroundColor Cyan
    return $metricsFile
}

$stateDir = Join-Path $RepoRoot $AgentStateDir
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$roles = Read-Roles -RepoRoot $RepoRoot -RolesFile $RolesFile
if ($roles.Count -eq 0) {
    Write-Warning "No roles found in $RolesFile"
    return
}
foreach ($role in $roles) {
    Get-RoleMetrics -Role $role -StateDir $stateDir -WindowHours $WindowHours | Out-Null
}
