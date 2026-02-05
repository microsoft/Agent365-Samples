# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Updates appsettings.json configuration for .NET agents.

.DESCRIPTION
    Reads an existing appsettings.json file and applies configuration mappings.
    Supports nested properties using colon (:) or double underscore (__) notation.

.PARAMETER OutputPath
    The path to the appsettings.json file.

.PARAMETER ConfigMappings
    A hashtable of configuration key-value pairs. 
    Keys use colon notation for nested properties (e.g., "AzureOpenAI:Endpoint").

.EXAMPLE
    ./Generate-AppSettings.ps1 -OutputPath "./sample-agent/appsettings.json" -ConfigMappings @{ "AzureOpenAI:ApiKey" = "xxx" }
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    
    [Parameter(Mandatory = $false)]
    [hashtable]$ConfigMappings = @{}
)

$ErrorActionPreference = "Stop"

Write-Host "Updating appsettings.json at: $OutputPath" -ForegroundColor Cyan

# Helper function to set nested value using colon-separated path
function Set-NestedValue {
    param($obj, $path, $value)
    $parts = $path -split ':'
    $current = $obj
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $key = $parts[$i]
        if (-not $current.ContainsKey($key)) {
            $current[$key] = @{}
        }
        elseif ($current[$key] -isnot [hashtable]) {
            $current[$key] = @{}
        }
        $current = $current[$key]
    }
    # Handle boolean and numeric values
    $finalKey = $parts[-1]
    if ($value -eq 'true') {
        $current[$finalKey] = $true
    }
    elseif ($value -eq 'false') {
        $current[$finalKey] = $false
    }
    elseif ($value -match '^\d+$') {
        $current[$finalKey] = [int]$value
    }
    else {
        $current[$finalKey] = $value
    }
}

# Load existing appsettings.json
if (Test-Path $OutputPath) {
    # Read the file and strip JSON comments (// style)
    $lines = Get-Content $OutputPath
    $cleanLines = @()
    foreach ($line in $lines) {
        if ($line -match '^\s*//') {
            continue
        }
        $cleanLine = $line -replace '(?<![:])\s*//(?!/)[^"]*$', ''
        $cleanLines += $cleanLine
    }
    $jsonContent = $cleanLines -join "`n"
    
    try {
        $config = $jsonContent | ConvertFrom-Json -AsHashtable
        Write-Host "  Loaded existing: $OutputPath" -ForegroundColor Gray
    }
    catch {
        Write-Host "  Warning: Failed to parse existing appsettings.json, creating fresh config" -ForegroundColor Yellow
        Write-Host "  Error: $_" -ForegroundColor Yellow
        $config = @{}
    }
}
else {
    $config = @{}
    Write-Host "  Creating new config (no existing file found)" -ForegroundColor Yellow
}

# Apply config mappings
$configCount = 0
foreach ($key in $ConfigMappings.Keys) {
    $value = $ConfigMappings[$key]
    # Convert double underscore to colon for nested properties
    $normalizedKey = $key -replace '__', ':'
    Write-Host "  Setting: $normalizedKey" -ForegroundColor Gray
    Set-NestedValue $config $normalizedKey $value
    $configCount++
}

Write-Host "  Applied $configCount configuration values" -ForegroundColor Cyan

$config | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding utf8
Write-Host "appsettings.json updated successfully" -ForegroundColor Green
