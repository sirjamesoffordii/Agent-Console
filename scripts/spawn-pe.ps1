[CmdletBinding()]
param([switch]$Poke)
. $PSScriptRoot/spawn-common.ps1
Invoke-AgentSpawn `
    -Role 'PrincipalEngineerAgent' `
    -DefaultPrompt 'Resume the Principal Engineer loop: check the board, review open SE PRs, and drive the roadmap.' `
    -Reason 'spawn-pe' `
    -UserDataDir 'C:/Dev/vscode-agent-pe' `
    -Poke:$Poke
