# Pester-free smoke tests for agent-contract.psm1
# Run with:  pwsh -NoProfile -File tests/agent-contract.tests.ps1
#
# Exits with non-zero on failure. Prints a summary at the end.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repoRoot 'tools/agent-contract/agent-contract.psm1') -Force

$fail = 0
$pass = 0
function Assert($cond, $name) {
    if ($cond) {
        Write-Host "  OK  $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL $name" -ForegroundColor Red
        $script:fail++
    }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-contract-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Write-Host "== Test sandbox: $tmp" -ForegroundColor Cyan

    # --- Write-AgentKickoff -----------------------------------------------
    $kickoffFile = Write-AgentKickoff -RepoRoot $tmp -Role 'TestRole' -Reason 'unit-test' -Prompt 'hello world'
    Assert (Test-Path $kickoffFile) 'kickoff.json written'
    $payload = Get-Content $kickoffFile -Raw | ConvertFrom-Json
    Assert ($payload.role -eq 'TestRole') 'kickoff role field'
    Assert ($payload.reason -eq 'unit-test') 'kickoff reason field'
    Assert ($payload.prompt -eq 'hello world') 'kickoff prompt field'
    Assert ($payload.version -eq 1) 'kickoff version=1'
    Assert ($payload.epoch -gt 0) 'kickoff epoch is positive'
    Assert ([string]::IsNullOrEmpty($payload.ts) -eq $false) 'kickoff ts field'

    # Custom AgentStateDir
    $kickoffFile2 = Write-AgentKickoff -RepoRoot $tmp -Role 'R2' -Reason 'x' -AgentStateDir 'custom-state'
    Assert ($kickoffFile2 -like "*custom-state*R2*kickoff.json") 'custom AgentStateDir honored'

    # Re-write bumps epoch monotonically (or stays equal within same second)
    Start-Sleep -Milliseconds 1100
    $k2 = Write-AgentKickoff -RepoRoot $tmp -Role 'TestRole' -Reason 'again'
    $p2 = Get-Content $k2 -Raw | ConvertFrom-Json
    Assert ($p2.epoch -ge $payload.epoch) 'kickoff epoch is monotonic'
    Assert ($p2.reason -eq 'again') 'kickoff overwrite replaces reason'

    # --- Write-AgentNextPrompt --------------------------------------------
    $npFile = Write-AgentNextPrompt -RepoRoot $tmp -Role 'TestRole' -Prompt 'next step' -Reason 'planner'
    Assert (Test-Path $npFile) 'next-prompt.json written'
    $np = Get-Content $npFile -Raw | ConvertFrom-Json
    Assert ($np.prompt -eq 'next step') 'next-prompt prompt field'
    Assert ($np.reason -eq 'planner') 'next-prompt reason field'
    Assert ($np.version -eq 1) 'next-prompt version=1'
    Assert ($np.plannedAtEpoch -gt 0) 'next-prompt plannedAtEpoch set'

    # Explicit plannedAtEpoch honored
    $npFile2 = Write-AgentNextPrompt -RepoRoot $tmp -Role 'TestRole' -Prompt 'p' -Reason 'r' -PlannedAtEpoch 12345
    $np2 = Get-Content $npFile2 -Raw | ConvertFrom-Json
    Assert ($np2.plannedAtEpoch -eq 12345) 'next-prompt explicit plannedAtEpoch'

    # --- Write-AgentNextAction --------------------------------------------
    foreach ($action in 'poke','spawn','hard-restart','none') {
        $naFile = Write-AgentNextAction -RepoRoot $tmp -Role 'TestRole' -Action $action -Reason "try-$action"
        $na = Get-Content $naFile -Raw | ConvertFrom-Json
        Assert ($na.action -eq $action) "next-action accepts '$action'"
    }

    # Invalid action is rejected by ValidateSet
    $threw = $false
    try { Write-AgentNextAction -RepoRoot $tmp -Role 'TestRole' -Action 'nope' } catch { $threw = $true }
    Assert $threw 'next-action rejects invalid action'

    # --- Directory creation -----------------------------------------------
    $deepRoot = Join-Path $tmp 'deep'
    $deepFile = Write-AgentKickoff -RepoRoot $deepRoot -Role 'DeepRole' -Reason 'mkdir'
    Assert (Test-Path $deepFile) 'nested directories auto-created'

} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "== Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 } else { exit 0 }
