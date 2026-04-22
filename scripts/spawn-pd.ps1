[CmdletBinding()]
param([switch]$Poke)
. $PSScriptRoot/spawn-common.ps1
Invoke-AgentSpawn `
    -Role 'ProductDesignAgent' `
    -DefaultPrompt 'Resume the Product Design loop: audit usability on recently-merged surfaces, file design-only issues with acceptance criteria.' `
    -Reason 'spawn-pd' `
    -UserDataDir 'C:/Dev/vscode-agent-pd' `
    -Poke:$Poke
