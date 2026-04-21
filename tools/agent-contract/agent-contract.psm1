# Agent Console — PowerShell contract helpers
#
# Producer-side primitives for the JSON bus that the Agent Console VS Code
# extension consumes. Any repo that wants to spawn / poke / schedule agents
# driven by Agent Console can dot-source or Import-Module this file.
#
# Files written (all under <repoRoot>/<agentStateDir>/<role>/):
#   kickoff.json       — fresh kickoff; extension opens Copilot Chat
#   next-prompt.json   — preview of the next prompt the orchestrator will send
#   next-action.json   — planned action (poke | spawn | hard-restart | none)
#
# Usage:
#   Import-Module ./tools/agent-contract/agent-contract.psm1
#   Write-AgentKickoff -RepoRoot $repo -Role "SeniorEngineerAgent" `
#       -Reason "manual-spawn" -Prompt "Start next slice."
#
# The extension reads these files with a 5 s poll + fs.watch fallback and
# re-activates Copilot Chat with the embedded prompt. Payload schema is
# version 1.

function Write-AgentKickoff {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$Role,
        [Parameter(Mandatory)] [string]$Reason,
        [Parameter()] [string]$Prompt,
        [Parameter()] [string]$AgentStateDir = '.agent'
    )
    $dir = Join-Path $RepoRoot (Join-Path $AgentStateDir $Role)
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $file = Join-Path $dir 'kickoff.json'
    $payload = [ordered]@{
        role    = $Role
        ts      = (Get-Date).ToUniversalTime().ToString('o')
        epoch   = [int][double]::Parse((Get-Date -UFormat %s))
        reason  = $Reason
        prompt  = if ($PSBoundParameters.ContainsKey('Prompt')) { $Prompt } else { '' }
        version = 1
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $file -Encoding UTF8
    return $file
}

function Write-AgentNextPrompt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$Role,
        [Parameter(Mandatory)] [string]$Prompt,
        [Parameter(Mandatory)] [string]$Reason,
        [Parameter()] [int]$PlannedAtEpoch,
        [Parameter()] [string]$AgentStateDir = '.agent'
    )
    $dir = Join-Path $RepoRoot (Join-Path $AgentStateDir $Role)
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $file = Join-Path $dir 'next-prompt.json'
    $payload = [ordered]@{
        role           = $Role
        prompt         = $Prompt
        reason         = $Reason
        plannedAtEpoch = if ($PSBoundParameters.ContainsKey('PlannedAtEpoch')) { $PlannedAtEpoch } else { [int][double]::Parse((Get-Date -UFormat %s)) }
        ts             = (Get-Date).ToUniversalTime().ToString('o')
        version        = 1
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $file -Encoding UTF8
    return $file
}

function Write-AgentNextAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$Role,
        [Parameter(Mandatory)] [ValidateSet('poke','spawn','hard-restart','none')] [string]$Action,
        [Parameter()] [string]$Reason = '',
        [Parameter()] [int]$PlannedAtEpoch,
        [Parameter()] [string]$AgentStateDir = '.agent'
    )
    $dir = Join-Path $RepoRoot (Join-Path $AgentStateDir $Role)
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $file = Join-Path $dir 'next-action.json'
    $payload = [ordered]@{
        role           = $Role
        action         = $Action
        reason         = $Reason
        plannedAtEpoch = if ($PSBoundParameters.ContainsKey('PlannedAtEpoch')) { $PlannedAtEpoch } else { [int][double]::Parse((Get-Date -UFormat %s)) }
        ts             = (Get-Date).ToUniversalTime().ToString('o')
        version        = 1
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $file -Encoding UTF8
    return $file
}

Export-ModuleMember -Function Write-AgentKickoff, Write-AgentNextPrompt, Write-AgentNextAction
