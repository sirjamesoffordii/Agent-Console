# Smoke tests for scripts/metrics-rollup.ps1.
# Run with: pwsh -NoProfile -File tests/metrics-rollup.tests.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repoRoot 'scripts/metrics-rollup.ps1'

$fail = 0
$pass = 0
function Assert($cond, $name) {
    if ($cond) { Write-Host "  OK  $name" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL $name" -ForegroundColor Red;  $script:fail++ }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("metrics-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Write-Host "== Sandbox: $tmp" -ForegroundColor Cyan

    # Scratch workspace: roles.json + synthetic activity.jsonl
    $rolesDir = Join-Path $tmp '.github/agents'
    New-Item -ItemType Directory -Path $rolesDir -Force | Out-Null
    $roles = [ordered]@{
        version = 1
        roles   = @(
            [ordered]@{ id = 'Scribe'; shortId = 'S'; displayName = 'Scribe' }
        )
    }
    ($roles | ConvertTo-Json -Depth 4) | Set-Content (Join-Path $rolesDir 'roles.json') -Encoding UTF8

    $stateDir = Join-Path $tmp '.agent/Scribe'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

    $now    = [DateTime]::UtcNow
    $recent = $now.AddMinutes(-30).ToString('o')
    $old    = $now.AddDays(-3).ToString('o')      # outside 24h window — must be ignored

    $events = @(
        @{ ts = $recent; type = 'chat.turn.start'; summary = 'kick-off' }
        @{ ts = $recent; type = 'tool.call';       summary = 'edit_file' }
        @{ ts = $recent; type = 'tool.call';       summary = 'read_file' }
        @{ ts = $recent; type = 'error';           summary = 'boom: test failed' }
        @{ ts = $recent; type = 'chat.turn.end';   summary = 'task_complete' }
        @{ ts = $old;    type = 'state.tick';      summary = 'old and should be ignored' }
    )
    $lines = $events | ForEach-Object { $_ | ConvertTo-Json -Compress }
    Set-Content -Path (Join-Path $stateDir 'activity.jsonl') -Value $lines -Encoding UTF8

    # Run the rollup
    & pwsh -NoProfile -File $script -RepoRoot $tmp | Out-Null
    $metricsFile = Join-Path $stateDir 'metrics-daily.json'
    Assert (Test-Path $metricsFile) 'metrics-daily.json written'

    $metrics = Get-Content $metricsFile -Raw | ConvertFrom-Json
    Assert ($metrics.role -eq 'Scribe')              'role field correct'
    Assert ($metrics.windowHours -eq 24)             'default windowHours=24'
    Assert ($metrics.totalEvents -eq 5)              'old event excluded (5 kept of 6)'
    Assert ($metrics.counts.'tool.call' -eq 2)       'tool.call count = 2'
    Assert ($metrics.counts.'chat.turn.start' -eq 1) 'chat.turn.start count = 1'
    Assert ($metrics.counts.'chat.turn.end' -eq 1)   'chat.turn.end count = 1'
    Assert ($metrics.counts.error -eq 1)             'error count = 1'
    Assert ($metrics.lastError -eq 'boom: test failed') 'lastError captured'
    Assert ($metrics.version -eq 1)                  'schema version=1'

    # Custom window
    & pwsh -NoProfile -File $script -RepoRoot $tmp -WindowHours 1 | Out-Null
    $narrow = Get-Content $metricsFile -Raw | ConvertFrom-Json
    Assert ($narrow.windowHours -eq 1) 'custom windowHours=1 honored'
    Assert ($narrow.totalEvents -eq 5) '30-min-old events still in 1h window'

    # Empty activity → zeroed counts, no crash
    Remove-Item -Force (Join-Path $stateDir 'activity.jsonl')
    & pwsh -NoProfile -File $script -RepoRoot $tmp | Out-Null
    $empty = Get-Content $metricsFile -Raw | ConvertFrom-Json
    Assert ($empty.totalEvents -eq 0) 'missing activity.jsonl → totalEvents=0'
    Assert ($null -eq $empty.lastError) 'missing activity.jsonl → lastError null'

} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "== Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 } else { exit 0 }
