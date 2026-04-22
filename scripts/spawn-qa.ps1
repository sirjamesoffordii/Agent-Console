[CmdletBinding()]
param([switch]$Poke)
. $PSScriptRoot/spawn-common.ps1
Invoke-AgentSpawn `
    -Role 'QualityAssuranceAgent' `
    -DefaultPrompt 'Run the QA persona rotation: Jordan, Daniel, Rachel, Alex. File findings per lane and report a consensus.' `
    -Reason 'spawn-qa' `
    -UserDataDir 'C:/Dev/vscode-agent-qa' `
    -Poke:$Poke
