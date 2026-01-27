# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Captures and displays agent logs for debugging.

.DESCRIPTION
    Reads agent log files and displays them with sensitive values redacted.

.PARAMETER AgentPath
    The path to the agent directory.

.EXAMPLE
    ./Capture-AgentLogs.ps1 -AgentPath "./sample-agent"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$AgentPath
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AGENT LOGS (transcript)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$logFile = Join-Path $AgentPath "agent.log"
if (Test-Path $logFile) {
    Write-Host "Agent transcript file found at: $logFile" -ForegroundColor Green
    Write-Host "----------------------------------------"
    Get-Content $logFile
    Write-Host "----------------------------------------"
    Write-Host "End of agent transcript" -ForegroundColor Green
}
else {
    Write-Host "No agent.log file found at: $logFile" -ForegroundColor Yellow
}

# Check command output log
$outputLogFile = Join-Path $AgentPath "agent-output.log"
if (Test-Path $outputLogFile) {
    $outputContent = Get-Content $outputLogFile -Raw
    if (-not [string]::IsNullOrWhiteSpace($outputContent)) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "AGENT COMMAND OUTPUT" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host $outputContent
    }
}

# Show .env file contents (redacted)
$envFile = Join-Path $AgentPath ".env"
if (Test-Path $envFile) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ".ENV FILE (secrets redacted)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^(BEARER_TOKEN|.*SECRET|.*PASSWORD|.*KEY)=') {
            $name = $_ -replace '=.*', ''
            $value = $_ -replace '^[^=]+=', ''
            Write-Host "$name=***REDACTED*** (length: $($value.Length))"
        }
        else {
            Write-Host $_
        }
    }
}

# Show wrapper script (redacted)
$wrapperScript = Join-Path $AgentPath "run-agent.ps1"
if (Test-Path $wrapperScript) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "WRAPPER SCRIPT (tokens redacted)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Get-Content $wrapperScript | ForEach-Object {
        if ($_ -match "BEARER_TOKEN\s*=\s*'") {
            Write-Host "`$env:BEARER_TOKEN = '***REDACTED***'"
        }
        else {
            Write-Host $_
        }
    }
}
