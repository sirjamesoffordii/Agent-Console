[CmdletBinding()]
param([switch]$Poke)
. $PSScriptRoot/spawn-common.ps1
Invoke-AgentSpawn `
    -Role 'SeniorEngineerAgent' `
    -DefaultPrompt 'Resume the Senior Engineer loop: pick the next Todo, critique direction, then implement with tests.' `
    -Reason 'spawn-se' `
    -UserDataDir 'C:/Dev/vscode-agent-se' `
    -Poke:$Poke
