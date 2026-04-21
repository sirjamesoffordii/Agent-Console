# End-to-end smoke: launch VS Code Insiders with the published Agent Console
# extension installed and a prepared test workspace, then verify that the
# extension actually activates and writes state.json + activity.jsonl.
#
# Usage:
#   pwsh -NoProfile -File tests/e2e-smoke.ps1
#
# Optional env:
#   $env:AGENT_CONSOLE_E2E_UDD   — user-data-dir to use (default: a temp dir)
#   $env:AGENT_CONSOLE_E2E_KEEP  — "1" to keep the test workspace after
#
# Exits 0 on success, non-zero on failure.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$vsix     = Join-Path $repoRoot 'dist/agent-console.vsix'
if (-not (Test-Path $vsix)) {
    Write-Host "Missing $vsix — running 'npm run package' first..." -ForegroundColor Yellow
    Push-Location $repoRoot
    try { npm run package | Out-Null } finally { Pop-Location }
}

# 1. Prepare scratch workspace ------------------------------------------------
$ws = Join-Path ([System.IO.Path]::GetTempPath()) ("ac-e2e-ws-" + [guid]::NewGuid().ToString('N'))
$udd = if ($env:AGENT_CONSOLE_E2E_UDD) { $env:AGENT_CONSOLE_E2E_UDD } else {
    Join-Path ([System.IO.Path]::GetTempPath()) ("ac-e2e-udd-" + [guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Path $ws -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ws '.github/agents') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ws '.agent/E2EAgent') -Force | Out-Null

# roles.json
@{
    version = 1
    roles = @(@{ id = 'E2EAgent'; shortId = 'E'; displayName = 'E2E Agent' })
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $ws '.github/agents/roles.json')

# settings.json — force role via workspace config
New-Item -ItemType Directory -Path (Join-Path $ws '.vscode') -Force | Out-Null
@{
    'agentConsole.role' = 'E2EAgent'
    'agentConsole.agentStateDir' = '.agent'
    'agentConsole.rolesFile' = '.github/agents/roles.json'
} | ConvertTo-Json | Set-Content (Join-Path $ws '.vscode/settings.json')

# kickoff.json
$epoch = [int][double]::Parse((Get-Date -UFormat %s))
@{
    role = 'E2EAgent'
    ts = (Get-Date).ToUniversalTime().ToString('o')
    epoch = $epoch
    reason = 'e2e-smoke'
    version = 1
    prompt = 'E2E smoke test prompt.'
} | ConvertTo-Json | Set-Content (Join-Path $ws '.agent/E2EAgent/kickoff.json')

Write-Host "== Workspace: $ws" -ForegroundColor Cyan
Write-Host "== UDD:       $udd" -ForegroundColor Cyan

# 2. Resolve Insiders CLI ------------------------------------------------------
$cli = $null
foreach ($cand in @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
    "C:\Program Files\Microsoft VS Code Insiders\bin\code-insiders.cmd"
)) {
    if (Test-Path $cand) { $cli = $cand; break }
}
if (-not $cli) {
    # Try PATH
    $cmd = Get-Command code-insiders -ErrorAction SilentlyContinue
    if ($cmd) { $cli = $cmd.Source }
}
if (-not $cli) {
    Write-Host "FAIL: code-insiders not found on PATH or usual install locations." -ForegroundColor Red
    exit 1
}
Write-Host "== CLI:       $cli" -ForegroundColor Cyan

# 3. Install the extension into the test UDD -----------------------------------
Write-Host ""
Write-Host "[1/3] Installing VSIX..." -ForegroundColor Yellow
& $cli --user-data-dir $udd --extensions-dir (Join-Path $udd 'ext') --install-extension $vsix --force 2>&1 | Write-Host

# 4. Launch Insiders, let extension activate, then close it --------------------
Write-Host ""
Write-Host "[2/3] Launching Insiders to activate extension..." -ForegroundColor Yellow

# Start it async; kill after activity appears or timeout
$proc = Start-Process -FilePath $cli `
    -ArgumentList @(
        '--user-data-dir', $udd,
        '--extensions-dir', (Join-Path $udd 'ext'),
        '--disable-workspace-trust',
        '--new-window',
        $ws
    ) -PassThru

$statePath    = Join-Path $ws '.agent/E2EAgent/state.json'
$activityPath = Join-Path $ws '.agent/E2EAgent/activity.jsonl'
$deadline = (Get-Date).AddSeconds(45)
$saw = @{ state = $false; activity = $false }

while ((Get-Date) -lt $deadline) {
    if (-not $saw.state    -and (Test-Path $statePath))    { $saw.state = $true;    Write-Host "  saw state.json"    -ForegroundColor Green }
    if (-not $saw.activity -and (Test-Path $activityPath)) { $saw.activity = $true; Write-Host "  saw activity.jsonl" -ForegroundColor Green }
    if ($saw.state -and $saw.activity) { break }
    Start-Sleep -Milliseconds 1000
}

Write-Host ""
Write-Host "[3/3] Closing Insiders..." -ForegroundColor Yellow
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
# Kill any lingering child electron processes that share the UDD
Get-Process | Where-Object { $_.Path -and $_.Path -like "*Code - Insiders*" -and $_.CommandLine -like "*$udd*" } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }

# 5. Assertions ----------------------------------------------------------------
Write-Host ""
Write-Host "== Results ==" -ForegroundColor Cyan
$fail = 0
function Assert($cond, $name) {
    if ($cond) { Write-Host "  OK   $name" -ForegroundColor Green } else { Write-Host "  FAIL $name" -ForegroundColor Red; $script:fail++ }
}
Assert $saw.state    'state.json written by real extension'
Assert $saw.activity 'activity.jsonl written by real extension'

if ($saw.state) {
    $s = Get-Content $statePath -Raw | ConvertFrom-Json
    Assert ($s.role -eq 'E2EAgent') 'state.role = E2EAgent'
    Assert ($s.version -eq 1)        'state.version = 1'
    Assert ($s.lastActivityEpoch -gt 0) 'state.lastActivityEpoch > 0'
}
if ($saw.activity) {
    # Retry-read: the file may be mid-flush when first spotted.
    [string[]]$lines = @()
    for ($i = 0; $i -lt 10 -and $lines.Length -eq 0; $i++) {
        $raw = Get-Content $activityPath -Raw -ErrorAction SilentlyContinue
        if ($raw) {
            [string[]]$lines = @(($raw.Trim() -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 })
        }
        if ($lines.Length -eq 0) { Start-Sleep -Milliseconds 300 }
    }
    Assert ($lines.Length -gt 0) 'activity.jsonl has >=1 line'
    if ($lines.Length -gt 0) {
        $first = $lines[0] | ConvertFrom-Json
        Assert ($first.type -eq 'state.tick') 'first activity event = state.tick'
        Assert ($first.role -eq 'E2EAgent')    'first activity event role = E2EAgent'
    }
}

# 6. Cleanup --------------------------------------------------------------------
if ($env:AGENT_CONSOLE_E2E_KEEP -ne '1') {
    Remove-Item -Recurse -Force $ws  -ErrorAction SilentlyContinue
    if (-not $env:AGENT_CONSOLE_E2E_UDD) {
        Remove-Item -Recurse -Force $udd -ErrorAction SilentlyContinue
    }
}

if ($fail -gt 0) { exit 1 } else { Write-Host ""; Write-Host "E2E SMOKE PASSED" -ForegroundColor Green; exit 0 }
