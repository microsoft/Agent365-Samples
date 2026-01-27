# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Starts an agent and waits for it to become ready.

.DESCRIPTION
    Creates a PowerShell wrapper script to set environment variables and start the agent.
    Waits for the agent to respond on the health endpoint or messages endpoint.

.PARAMETER AgentPath
    The path to the agent directory.

.PARAMETER StartCommand
    The command to start the agent (e.g., "npm start", "dotnet run").

.PARAMETER Port
    The port the agent will listen on.

.PARAMETER BearerToken
    The bearer token for MCP authentication.

.PARAMETER HealthEndpoint
    The health check endpoint path. Defaults to "/api/health".

.PARAMETER Environment
    The MCP environment mode. Defaults to "Development".

.PARAMETER TimeoutSeconds
    Maximum time to wait for agent to become ready. Defaults to 90 seconds.

.PARAMETER Runtime
    The runtime type (python, nodejs, dotnet).

.OUTPUTS
    Returns the process ID of the started agent.

.EXAMPLE
    $pid = ./Start-Agent.ps1 -AgentPath "./sample-agent" -StartCommand "npm start" -Port 3979 -BearerToken $token
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$AgentPath,
    
    [Parameter(Mandatory = $true)]
    [string]$StartCommand,
    
    [Parameter(Mandatory = $true)]
    [int]$Port,
    
    [Parameter(Mandatory = $true)]
    [string]$BearerToken,
    
    [Parameter(Mandatory = $false)]
    [string]$HealthEndpoint = "/api/health",
    
    [Parameter(Mandatory = $false)]
    [string]$Environment = "Development",
    
    [Parameter(Mandatory = $false)]
    [int]$TimeoutSeconds = 90,
    
    [Parameter(Mandatory = $false)]
    [ValidateSet("python", "nodejs", "dotnet")]
    [string]$Runtime = "nodejs"
)

$ErrorActionPreference = "Stop"

# Resolve to absolute path
$AgentPath = Resolve-Path $AgentPath | Select-Object -ExpandProperty Path

# Handle empty Environment parameter - default to Development for local ToolingManifest.json
if ([string]::IsNullOrEmpty($Environment)) {
    Write-Host "Environment not set, defaulting to: Development" -ForegroundColor Yellow
    $Environment = "Development"
}

Write-Host "Starting agent on port $Port..." -ForegroundColor Cyan
Write-Host "  Command: $StartCommand" -ForegroundColor Gray
Write-Host "  Path: $AgentPath" -ForegroundColor Gray
Write-Host "  Runtime: $Runtime" -ForegroundColor Gray
Write-Host "  Environment: $Environment" -ForegroundColor Gray

# Verify config file exists based on runtime
if ($Runtime -eq "dotnet") {
    $configPath = Join-Path $AgentPath "appsettings.json"
    $configType = "appsettings.json"
}
else {
    $configPath = Join-Path $AgentPath ".env"
    $configType = ".env"
}

if (-not (Test-Path $configPath)) {
    Write-Host "  ERROR: $configType file not found at $configPath" -ForegroundColor Red
    throw "$configType file not found"
}

Write-Host "  $configType file exists at: $configPath" -ForegroundColor Green

# Show config with secrets masked
if ($Runtime -eq "dotnet") {
    Write-Host "  $configType contents (secrets masked):" -ForegroundColor Gray
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $configJson = $config | ConvertTo-Json -Depth 5
    $configJson = $configJson -replace '("(?:ApiKey|ClientSecret|Password|Secret|Token|Key)":\s*")[^"]+(")', '$1***$2'
    Write-Host $configJson -ForegroundColor DarkGray
}
else {
    Write-Host "  $configType contents (masked):" -ForegroundColor Gray
    Get-Content $configPath | ForEach-Object {
        if ($_ -match '^([^=]+)=') {
            $key = $Matches[1]
            if ($key -match 'KEY|SECRET|TOKEN|PASSWORD') {
                Write-Host "    $key=***" -ForegroundColor Gray
            }
            else {
                Write-Host "    $_" -ForegroundColor Gray
            }
        }
    }
}

# Create log files
$logFile = Join-Path $AgentPath "agent.log"
$errorLogFile = Join-Path $AgentPath "agent-error.log"

# Validate bearer token
if ([string]::IsNullOrEmpty($BearerToken)) {
    Write-Host "  ERROR: Cannot start agent - BEARER_TOKEN is empty!" -ForegroundColor Red
    throw "BEARER_TOKEN is required"
}
Write-Host "  BEARER_TOKEN length: $($BearerToken.Length)" -ForegroundColor Green

# Create PowerShell wrapper script
$wrapperScript = Join-Path $AgentPath "run-agent.ps1"
$escapedToken = $BearerToken -replace "'", "''"

# Build wrapper script with error handling and diagnostics
$scriptLines = @(
    "`$ErrorActionPreference = 'Continue'"
    "Write-Host '=== Agent Wrapper Script Started ==='"
    "Write-Host 'Working Directory:' (Get-Location)"
    "Write-Host 'PowerShell Version:' `$PSVersionTable.PSVersion"
    ""
    "# Set environment variables"
    "`$env:PORT = '$Port'"
    "`$env:ASPNETCORE_URLS = 'http://localhost:$Port'"
    "`$env:BEARER_TOKEN = '$escapedToken'"
    "`$env:PYTHONIOENCODING = 'utf-8'"
    "`$env:ENVIRONMENT = '$Environment'"
    "`$env:NODE_ENV = 'development'"
    ""
    "Write-Host 'Environment configured:'"
    "Write-Host '  PORT=' `$env:PORT"
    "Write-Host '  BEARER_TOKEN length:' `$env:BEARER_TOKEN.Length"
    "Write-Host '  ENVIRONMENT:' `$env:ENVIRONMENT"
    "Write-Host '  NODE_ENV:' `$env:NODE_ENV"
    ""
    "Write-Host 'Directory contents:'"
    "Get-ChildItem -Name | ForEach-Object { Write-Host `"  `$_`" }"
    ""
    "Write-Host '=== Starting Agent Command ==='"
    "Write-Host 'Command: $StartCommand'"
    ""
    "try {"
    "    $StartCommand"
    "} catch {"
    "    Write-Host 'ERROR: Agent command failed!' -ForegroundColor Red"
    "    Write-Host `$_.Exception.Message"
    "    Write-Host `$_.ScriptStackTrace"
    "    exit 1"
    "}"
)
$scriptContent = $scriptLines -join "`r`n"
[System.IO.File]::WriteAllText($wrapperScript, $scriptContent)

Write-Host "PowerShell wrapper script created at: $wrapperScript" -ForegroundColor Gray

# Start the agent process
Push-Location $AgentPath
try {
    $process = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wrapperScript `
        -WorkingDirectory $AgentPath -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $logFile -RedirectStandardError $errorLogFile
    
    Write-Host "Agent process started (PID: $($process.Id))" -ForegroundColor Green
    
    # Give the process a moment to start and write initial output
    Start-Sleep -Seconds 2
    
    # Wait for agent to be ready
    $elapsed = 2
    $ready = $false
    
    $healthUrl = "http://localhost:$Port$HealthEndpoint"
    $messagesUrl = "http://localhost:$Port/api/messages"
    
    Write-Host "Waiting for agent to be ready (timeout: $TimeoutSeconds seconds)..." -ForegroundColor Gray
    Write-Host "  Checking: $healthUrl and $messagesUrl" -ForegroundColor Gray
    
    $healthError = ""
    
    while ($elapsed -lt $TimeoutSeconds) {
        # Check if process died
        if ($process.HasExited) {
            Write-Host "Agent process exited prematurely!" -ForegroundColor Red
            Write-Host "Exit code: $($process.ExitCode)" -ForegroundColor Red
            
            # Wait a moment for file handles to be released
            Start-Sleep -Milliseconds 500
            
            if (Test-Path $logFile) {
                $logContent = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
                if ($logContent) {
                    Write-Host "Agent logs:" -ForegroundColor Yellow
                    Write-Host $logContent
                } else {
                    Write-Host "Agent log file exists but is empty" -ForegroundColor Yellow
                }
            } else {
                Write-Host "No agent log file found at: $logFile" -ForegroundColor Yellow
            }
            
            if (Test-Path $errorLogFile) {
                $errorContent = Get-Content $errorLogFile -Raw -ErrorAction SilentlyContinue
                if ($errorContent) {
                    Write-Host "Agent error logs:" -ForegroundColor Red
                    Write-Host $errorContent
                }
            }
            
            throw "Agent process exited with code $($process.ExitCode)"
        }
        
        # Try health endpoint first
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -Method GET -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                $ready = $true
                Write-Host "Agent is ready! (health endpoint returned 200)" -ForegroundColor Green
                break
            }
        }
        catch {
            $healthError = $_.Exception.Message
            if ($elapsed % 15 -eq 0) {
                Write-Host "  Health check error: $healthError" -ForegroundColor DarkYellow
            }
            # Try messages endpoint - 405 means it's running
            try {
                $response = Invoke-WebRequest -Uri $messagesUrl -Method GET -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            }
            catch {
                if ($_.Exception.Response.StatusCode.value__ -eq 405) {
                    $ready = $true
                    Write-Host "Agent is ready! (messages endpoint returned 405)" -ForegroundColor Green
                    break
                }
            }
        }
        
        Start-Sleep -Seconds 3
        $elapsed += 3
        Write-Host "  Waiting... ($elapsed/$TimeoutSeconds seconds)" -ForegroundColor Gray
        
        # Show recent log output every 15 seconds
        if ($elapsed % 15 -eq 0 -and (Test-Path $logFile)) {
            Write-Host "  Recent agent output:" -ForegroundColor Gray
            Get-Content $logFile -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    }
    
    if (-not $ready) {
        Write-Host "`nAgent did not become ready within $TimeoutSeconds seconds" -ForegroundColor Red
        Write-Host "Last health check error: $healthError" -ForegroundColor Red
        
        # Diagnostics
        Write-Host "`nFinal diagnostic check:" -ForegroundColor Yellow
        try {
            $diag = Invoke-WebRequest -Uri $healthUrl -Method GET -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            Write-Host "  Unexpected success: StatusCode=$($diag.StatusCode)" -ForegroundColor Green
        }
        catch {
            Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
        }
        
        # Check port
        $netstat = netstat -ano | Select-String ":$Port"
        if ($netstat) {
            Write-Host "`nPort $Port listeners:" -ForegroundColor Yellow
            $netstat | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        }
        else {
            Write-Host "`nNo process listening on port $Port!" -ForegroundColor Red
        }
        
        if (Test-Path $logFile) {
            Write-Host "`nFull agent logs:" -ForegroundColor Yellow
            Get-Content $logFile
        }
        
        throw "Agent did not become ready within $TimeoutSeconds seconds"
    }
    
    # Verify process is still running before returning
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
        Write-Host "WARNING: Agent process exited after becoming ready!" -ForegroundColor Red
        Write-Host "Exit code: $($process.ExitCode)" -ForegroundColor Red
        if (Test-Path $logFile) {
            Write-Host "Agent logs:" -ForegroundColor Yellow
            Get-Content $logFile
        }
        throw "Agent process exited unexpectedly after health check passed"
    }
    
    Write-Host "Agent process (PID: $($process.Id)) is running and healthy" -ForegroundColor Green
    
    # Return the process ID
    return $process.Id
}
finally {
    Pop-Location
}
