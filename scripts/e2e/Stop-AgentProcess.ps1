# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Stops the agent process and cleans up.

.DESCRIPTION
    Stops the agent process by PID and/or by killing any process on the specified port.

.PARAMETER AgentPID
    The process ID of the agent to stop.

.PARAMETER Port
    The port to clean up. Any process listening on this port will be terminated.

.EXAMPLE
    ./Stop-AgentProcess.ps1 -AgentPID 1234 -Port 3979
#>

param(
    [Parameter(Mandatory = $false)]
    [string]$AgentPID,
    
    [Parameter(Mandatory = $false)]
    [int]$Port = 3979
)

Write-Host "Cleaning up agent process..." -ForegroundColor Yellow

# Stop the agent process if PID was provided
if ($AgentPID -and $AgentPID -match '^\d+$') {
    Write-Host "Stopping agent process (PID: $AgentPID)..." -ForegroundColor Gray
    Stop-Process -Id $AgentPID -Force -ErrorAction SilentlyContinue
}

# Kill any process on the port as backup
$connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($connections) {
    Write-Host "Cleaning up processes on port $Port..." -ForegroundColor Gray
    $connections | Select-Object -ExpandProperty OwningProcess | 
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

Write-Host "Cleanup complete" -ForegroundColor Green
