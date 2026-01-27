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

# Log file paths - the wrapper script creates these via Start-Transcript and Tee-Object
$logFile = Join-Path $AgentPath "agent.log"           # PowerShell transcript
$outputLogFile = Join-Path $AgentPath "agent-output.log"  # Command output

# Validate bearer token
if ([string]::IsNullOrEmpty($BearerToken)) {
    Write-Host "  ERROR: Cannot start agent - BEARER_TOKEN is empty!" -ForegroundColor Red
    throw "BEARER_TOKEN is required"
}
Write-Host "  BEARER_TOKEN length: $($BearerToken.Length)" -ForegroundColor Green

# Create PowerShell wrapper script that handles its own logging
$wrapperScript = Join-Path $AgentPath "run-agent.ps1"
$escapedToken = $BearerToken -replace "'", "''"

# Build wrapper script with error handling and diagnostics
# Key change: The wrapper script handles its own logging via Start-Transcript
# This avoids issues with Start-Process -RedirectStandardOutput
$scriptLines = @(
    "`$ErrorActionPreference = 'Continue'"
    ""
    "# Set up logging via transcript"
    "`$logPath = Join-Path (Get-Location) 'agent.log'"
    "Start-Transcript -Path `$logPath -Force"
    ""
    "Write-Host '=== Agent Wrapper Script Started ==='"
    "Write-Host 'Working Directory:' (Get-Location)"
    "Write-Host 'PowerShell Version:' `$PSVersionTable.PSVersion"
    "Write-Host 'Log file:' `$logPath"
    ""
    "# Set environment variables"
    "`$env:PORT = '$Port'"
    "`$env:ASPNETCORE_URLS = 'http://localhost:$Port'"
    "`$env:BEARER_TOKEN = '$escapedToken'"
    "`$env:PYTHONIOENCODING = 'utf-8'"
    "`$env:PYTHONUNBUFFERED = '1'"
    "`$env:ENVIRONMENT = '$Environment'"
    "`$env:NODE_ENV = 'development'"
    ""
    "Write-Host 'Environment configured:'"
    "Write-Host '  PORT=' `$env:PORT"
    "Write-Host '  BEARER_TOKEN length:' `$env:BEARER_TOKEN.Length"
    "Write-Host '  ENVIRONMENT:' `$env:ENVIRONMENT"
    ""
    "Write-Host '=== Pre-flight Checks ==='"
)

# Add runtime-specific pre-flight checks
if ($Runtime -eq "python") {
    $scriptLines += @(
        "Write-Host 'Checking Python environment...'"
        "uv run python --version"
        "Write-Host 'Python packages:'"
        "uv run pip list | Select-Object -First 20"
        "Write-Host ''"
        "Write-Host 'Testing Python can import main script...'"
        "uv run python -c `"import start_with_generic_host; print('Import OK')`""
        "if (`$LASTEXITCODE -ne 0) {"
        "    Write-Host 'ERROR: Failed to import start_with_generic_host.py' -ForegroundColor Red"
        "    exit 1"
        "}"
    )
}
elseif ($Runtime -eq "nodejs") {
    $scriptLines += @(
        "Write-Host 'Checking Node.js environment...'"
        "node --version"
        "Write-Host 'Checking if entry point exists...'"
        "if (Test-Path 'dist/index.js') { Write-Host 'dist/index.js exists' } else { Write-Host 'ERROR: dist/index.js not found!' -ForegroundColor Red; exit 1 }"
    )
}
elseif ($Runtime -eq "dotnet") {
    $scriptLines += @(
        "Write-Host 'Checking .NET environment...'"
        "dotnet --version"
    )
}

$scriptLines += @(
    ""
    "Write-Host '=== Starting Agent Command ==='"
    "Write-Host 'Command: $StartCommand'"
    "Write-Host ''"
    ""
    "# Run the command - this should be a long-running server process"
    "# Pipe both stdout and stderr to Tee-Object to capture in log"
    "try {"
    "    $StartCommand *>&1 | Tee-Object -FilePath (Join-Path (Get-Location) 'agent-output.log')"
    "} catch {"
    "    Write-Host 'Exception running command:' `$_.Exception.Message -ForegroundColor Red"
    "}"
    ""
    "# If we get here, the server exited"
    "`$exitCode = `$LASTEXITCODE"
    "Write-Host ''"
    "Write-Host '=== Agent Process Exited ===' -ForegroundColor Yellow"
    "Write-Host 'Exit code:' `$exitCode"
    "if (`$exitCode -ne 0) {"
    "    Write-Host 'ERROR: Server exited with non-zero code' -ForegroundColor Red"
    "}"
    "Stop-Transcript -ErrorAction SilentlyContinue"
    "exit `$exitCode"
)
$scriptContent = $scriptLines -join "`r`n"
[System.IO.File]::WriteAllText($wrapperScript, $scriptContent)

Write-Host "PowerShell wrapper script created at: $wrapperScript" -ForegroundColor Gray

# Start the agent process
# The wrapper script handles its own logging, so we don't redirect stdout/stderr
# This avoids file handle issues that can cause the process to exit unexpectedly
Push-Location $AgentPath
try {
    # Start the wrapper script directly without output redirection
    # The wrapper uses Start-Transcript and Tee-Object for logging
    $process = Start-Process -FilePath "pwsh" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wrapperScript `
        -WorkingDirectory $AgentPath -PassThru -WindowStyle Hidden
    
    Write-Host "Agent process started (PID: $($process.Id))" -ForegroundColor Green
    
    # Give the process a moment to start and initialize transcript
    Start-Sleep -Seconds 3
    
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
            
            # Show transcript log
            if (Test-Path $logFile) {
                $logContent = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
                if ($logContent) {
                    Write-Host "Agent transcript log:" -ForegroundColor Yellow
                    Write-Host $logContent
                } else {
                    Write-Host "Agent transcript file exists but is empty" -ForegroundColor Yellow
                }
            } else {
                Write-Host "No agent transcript file found at: $logFile" -ForegroundColor Yellow
            }
            
            # Show command output log
            if (Test-Path $outputLogFile) {
                $outputContent = Get-Content $outputLogFile -Raw -ErrorAction SilentlyContinue
                if ($outputContent) {
                    Write-Host "Agent command output:" -ForegroundColor Yellow
                    Write-Host $outputContent
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
                $exResponse = $_.Exception.Response
                if ($exResponse -and $exResponse.StatusCode -eq 405) {
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
    # Wait a bit longer to ensure the agent is stable
    Write-Host "Verifying agent stability..." -ForegroundColor Gray
    for ($i = 1; $i -le 5; $i++) {
        Start-Sleep -Seconds 1
        if ($process.HasExited) {
            Write-Host "WARNING: Agent process exited during stability check (iteration $i)!" -ForegroundColor Red
            Write-Host "Exit code: $($process.ExitCode)" -ForegroundColor Red
            
            Start-Sleep -Milliseconds 500
            if (Test-Path $logFile) {
                Write-Host "Agent transcript log:" -ForegroundColor Yellow
                Get-Content $logFile
            }
            if (Test-Path $outputLogFile) {
                $outContent = Get-Content $outputLogFile -Raw
                if ($outContent) {
                    Write-Host "Agent command output:" -ForegroundColor Yellow
                    Write-Host $outContent
                }
            }
            throw "Agent process exited unexpectedly after health check passed"
        }
        
        # Also verify health endpoint still works
        try {
            $check = Invoke-WebRequest -Uri $healthUrl -Method GET -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            Write-Host "  Stability check $i/5: OK (health: $($check.StatusCode))" -ForegroundColor Gray
        }
        catch {
            Write-Host "  Stability check $i/5: Health check failed - $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    
    Write-Host "Agent process (PID: $($process.Id)) is running and stable" -ForegroundColor Green
    
    # Return the process ID
    return $process.Id
}
finally {
    Pop-Location
}
