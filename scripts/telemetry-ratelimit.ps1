# Agent Console — GH rate-limit telemetry writer
#
# For each role in roles.json, invokes `gh api rate_limit` under the role's
# GH_CONFIG_DIR and writes `<agentStateDir>/<role>/ratelimit.json` in the
# schema the Agent Console webview consumes:
#
#   { ts, ok, error?, resources: { core, search, graphql: { limit, remaining, reset } } }
#
# Also writes `<agentStateDir>/<role>/usage.json` (best-effort) with the
# most-recent observation, intended to power trend sparklines later.
#
# Schedule via Task Scheduler every 1-2 minutes, or loop with `-Watch`.

[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$RolesFile = '.github/agents/roles.json',
    [string]$AgentStateDir = '.agent',
    [switch]$Watch,
    [int]$WatchIntervalSec = 90
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

function Write-RoleRateLimit {
    param(
        [Parameter(Mandatory)] [pscustomobject]$Role,
        [Parameter(Mandatory)] [string]$StateDir
    )
    $dir = Join-Path $StateDir $Role.id
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $rlFile    = Join-Path $dir 'ratelimit.json'
    $usageFile = Join-Path $dir 'usage.json'

    $payload = [ordered]@{
        role      = $Role.id
        ts        = (Get-Date).ToUniversalTime().ToString('o')
        ok        = $false
        error     = $null
        resources = $null
    }

    $ghExe = (Get-Command gh -ErrorAction SilentlyContinue)?.Source
    if (-not $ghExe) {
        $payload.error = 'gh CLI not on PATH'
    } else {
        $env:GH_CONFIG_DIR = $Role.ghConfigDir
        try {
            $raw = & $ghExe api rate_limit 2>&1
            if ($LASTEXITCODE -ne 0) { throw "gh api rate_limit failed: $raw" }
            $doc = $raw | ConvertFrom-Json
            $payload.ok = $true
            $payload.resources = [ordered]@{
                core    = @{ limit = $doc.resources.core.limit;    remaining = $doc.resources.core.remaining;    reset = $doc.resources.core.reset }
                search  = @{ limit = $doc.resources.search.limit;  remaining = $doc.resources.search.remaining;  reset = $doc.resources.search.reset }
                graphql = @{ limit = $doc.resources.graphql.limit; remaining = $doc.resources.graphql.remaining; reset = $doc.resources.graphql.reset }
            }
        } catch {
            $payload.error = $_.Exception.Message
        } finally {
            Remove-Item Env:\GH_CONFIG_DIR -ErrorAction SilentlyContinue
        }
    }

    $tmp = $rlFile + '.tmp'
    ($payload | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Force -Path $tmp -Destination $rlFile

    # usage.json is a thin derivative: used = limit - remaining (best-effort).
    $coreUsage = $null
    if ($payload.ok -and $payload.resources -and $payload.resources.Contains('core')) {
        $c = $payload.resources['core']
        $limit     = if ($c.ContainsKey('limit'))     { [int]$c['limit'] }     else { 0 }
        $remaining = if ($c.ContainsKey('remaining')) { [int]$c['remaining'] } else { 0 }
        $coreUsage = @{
            used      = [Math]::Max(0, $limit - $remaining)
            limit     = $limit
            remaining = $remaining
        }
    }
    $usage = [ordered]@{
        role = $Role.id
        ts   = $payload.ts
        ok   = $payload.ok
        core = $coreUsage
    }
    $tmp2 = $usageFile + '.tmp'
    ($usage | ConvertTo-Json -Depth 4) | Set-Content -Path $tmp2 -Encoding UTF8
    Move-Item -Force -Path $tmp2 -Destination $usageFile

    Write-Host "[$($Role.id)] ok=$($payload.ok) core=$(if ($coreUsage) { "$($coreUsage.remaining)/$($coreUsage.limit)" } else { 'n/a' })" -ForegroundColor Cyan
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
        if (-not $role.ghConfigDir) {
            Write-Warning "skip $($role.id) — no ghConfigDir in manifest"
            continue
        }
        Write-RoleRateLimit -Role $role -StateDir $stateDir
    }
}

if ($Watch) {
    Write-Host "watching rate limits every ${WatchIntervalSec}s (Ctrl+C to stop)" -ForegroundColor Green
    while ($true) {
        Invoke-Once
        Start-Sleep -Seconds $WatchIntervalSec
    }
} else {
    Invoke-Once
}
