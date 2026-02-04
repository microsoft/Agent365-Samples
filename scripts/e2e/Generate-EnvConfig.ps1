# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Generates a .env configuration file for Python or Node.js agents.

.DESCRIPTION
    Creates a .env file with the provided configuration mappings and bearer token.
    Sensitive values are masked in the output.

.PARAMETER OutputPath
    The path to write the .env file.

.PARAMETER BearerToken
    The bearer token for MCP authentication.

.PARAMETER Port
    The port the agent will listen on.

.PARAMETER ConfigMappings
    A hashtable of additional configuration key-value pairs.

.EXAMPLE
    ./Generate-EnvConfig.ps1 -OutputPath "./sample-agent/.env" -BearerToken $token -Port 3979 -ConfigMappings @{ "NODE_ENV" = "development" }
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    
    [Parameter(Mandatory = $true)]
    [string]$BearerToken,
    
    [Parameter(Mandatory = $false)]
    [int]$Port = 3979,
    
    [Parameter(Mandatory = $false)]
    [hashtable]$ConfigMappings = @{}
)

$ErrorActionPreference = "Stop"

Write-Host "Generating .env at: $OutputPath" -ForegroundColor Cyan

# Validate BEARER_TOKEN is available
if ([string]::IsNullOrEmpty($BearerToken)) {
    Write-Host "ERROR: BEARER_TOKEN is empty or not set!" -ForegroundColor Red
    throw "BEARER_TOKEN is required"
}
Write-Host "BEARER_TOKEN available (length: $($BearerToken.Length) chars)" -ForegroundColor Green

$envContent = @()
$envContent += "# Auto-generated configuration"
$envContent += "# Generated at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$envContent += ""

# Add BEARER_TOKEN
$envContent += "BEARER_TOKEN=$BearerToken"

# Add PORT
$envContent += "PORT=$Port"

# Add all config mappings
foreach ($key in $ConfigMappings.Keys) {
    $value = $ConfigMappings[$key]
    $envContent += "$key=$value"
}

# Write file
$envContent | Out-File -FilePath $OutputPath -Encoding utf8

Write-Host "Configuration generated:" -ForegroundColor Green
Get-Content $OutputPath | ForEach-Object {
    if ($_ -match '^([^=]+)=') {
        $key = $Matches[1]
        if ($key -match 'KEY|SECRET|TOKEN|PASSWORD') {
            $value = $_.Split('=', 2)[1]
            Write-Host "  $key=*** (length: $($value.Length))" -ForegroundColor Gray
        }
        else {
            Write-Host "  $_" -ForegroundColor Gray
        }
    }
}

Write-Host ".env file generated successfully" -ForegroundColor Green
