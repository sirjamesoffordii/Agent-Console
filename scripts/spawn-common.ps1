# Shared spawn helpers for Agent Console role scripts.
#
# Each scripts/spawn-<role>.ps1 dot-sources this file to get the same behavior:
#   - read .agent/<role>/prompt-override.txt (if any) → that becomes the
#     kickoff prompt; otherwise the default prompt from the role script is used
#   - write a kickoff.json via Write-AgentKickoff
#   - optionally launch a VS Code Insiders window bound to userDataDir
#
# These scripts are intentionally thin — operators can extend them per-role
# without forking the core logic.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Import-AgentContract {
    $repoRoot = Get-AgentConsoleRepoRoot
    $module = Join-Path $repoRoot 'tools/agent-contract/agent-contract.psm1'
    if (-not (Test-Path $module)) { throw "agent-contract module not found at $module" }
    Import-Module $module -Force
}

function Get-AgentConsoleRepoRoot {
    $here = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $PSScriptRoot }
    if (-not $here) { $here = (Get-Location).Path }
    return (Resolve-Path (Join-Path $here '..')).Path
}

function Read-PromptOverride {
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$Role,
        [string]$AgentStateDir = '.agent'
    )
    $file = Join-Path $RepoRoot (Join-Path $AgentStateDir (Join-Path $Role 'prompt-override.txt'))
    if (-not (Test-Path $file)) { return '' }
    return Get-Content -Raw $file
}

function Invoke-AgentSpawn {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Role,
        [Parameter(Mandatory)] [string]$DefaultPrompt,
        [Parameter(Mandatory)] [string]$Reason,
        [string]$UserDataDir,
        [switch]$Poke
    )
    Import-AgentContract
    $repoRoot = Get-AgentConsoleRepoRoot

    $override = Read-PromptOverride -RepoRoot $repoRoot -Role $Role
    $prompt = if ($override.Trim().Length -gt 0) { $override } else { $DefaultPrompt }

    $kickoff = Write-AgentKickoff -RepoRoot $repoRoot -Role $Role -Reason $Reason -Prompt $prompt
    Write-Host "kickoff -> $kickoff" -ForegroundColor Cyan

    if ($Poke) { return }

    if ($UserDataDir) {
        $exe = (Get-Command code-insiders -ErrorAction SilentlyContinue)?.Source
        if (-not $exe) { $exe = (Get-Command code -ErrorAction SilentlyContinue)?.Source }
        if ($exe) {
            $args = @('--user-data-dir', $UserDataDir, $repoRoot)
            Start-Process -FilePath $exe -ArgumentList $args | Out-Null
            Write-Host "launched $(Split-Path -Leaf $exe) with user-data-dir=$UserDataDir" -ForegroundColor Green
        } else {
            Write-Warning "VS Code not on PATH; kickoff written but no window launched."
        }
    }
}
