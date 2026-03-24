#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Tests the deployed Procurement Agent

.DESCRIPTION
    Validates that the deployed web app is functioning correctly by checking:
    - Web app is running
    - Health endpoint responds
    - Swagger UI is accessible
    - Application settings are configured

.PARAMETER ResourceGroup
    The Azure resource group containing the web app

.PARAMETER WebAppName
    The name of the Azure Web App

.EXAMPLE
    .\test-deployment.ps1
#>

param(
    [string]$ResourceGroup = "helloworld-rg",
    [string]$WebAppName = "zava-procurement-webapp"
)

$ErrorActionPreference = "Stop"

# Colors
function Write-TestHeader { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-TestPass { param([string]$msg) Write-Host "  ? $msg" -ForegroundColor Green }
function Write-TestFail { param([string]$msg) Write-Host "  ? $msg" -ForegroundColor Red }
function Write-TestWarn { param([string]$msg) Write-Host "  ??  $msg" -ForegroundColor Yellow }
function Write-TestInfo { param([string]$msg) Write-Host "  ??  $msg" -ForegroundColor Gray }

# Test results
$script:totalTests = 0
$script:passedTests = 0
$script:failedTests = 0
$script:warnings = 0

function Record-TestPass {
    $script:totalTests++
    $script:passedTests++
}

function Record-TestFail {
    $script:totalTests++
    $script:failedTests++
}

function Record-Warning {
    $script:warnings++
}

# Banner
Write-Host ""
Write-Host "??????????????????????????????????????????????????????????????" -ForegroundColor Magenta
Write-Host "?         Deployment Validation Tests                       ?" -ForegroundColor Magenta
Write-Host "??????????????????????????????????????????????????????????????" -ForegroundColor Magenta
Write-Host ""
Write-Host "Target: $WebAppName ($ResourceGroup)" -ForegroundColor Gray
Write-Host ""

# Test 1: Azure CLI
Write-TestHeader "Test 1: Azure CLI Availability"
try {
    $azVersion = az version --query '"azure-cli"' -o tsv 2>$null
    Write-TestPass "Azure CLI is installed (version: $azVersion)"
    Record-TestPass
} catch {
    Write-TestFail "Azure CLI is not installed"
    Record-TestFail
    exit 1
}

# Test 2: Azure Login
Write-TestHeader "Test 2: Azure Authentication"
try {
    $account = az account show 2>$null | ConvertFrom-Json
    if ($account) {
        Write-TestPass "Logged in as: $($account.user.name)"
        Write-TestInfo "Subscription: $($account.name)"
        Record-TestPass
    } else {
        Write-TestFail "Not logged in to Azure"
        Record-TestFail
        exit 1
    }
} catch {
    Write-TestFail "Azure authentication failed"
    Record-TestFail
    exit 1
}

# Test 3: Web App Exists
Write-TestHeader "Test 3: Web App Existence"
try {
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup 2>$null | ConvertFrom-Json
    if ($webApp) {
        Write-TestPass "Web app found: $WebAppName"
        Write-TestInfo "Location: $($webApp.location)"
        Write-TestInfo "URL: https://$($webApp.defaultHostName)"
        Record-TestPass
    } else {
        Write-TestFail "Web app not found"
        Record-TestFail
        exit 1
    }
} catch {
    Write-TestFail "Failed to retrieve web app information"
    Record-TestFail
    exit 1
}

# Test 4: Web App State
Write-TestHeader "Test 4: Web App State"
if ($webApp.state -eq "Running") {
    Write-TestPass "Web app is running"
    Record-TestPass
} else {
    Write-TestFail "Web app is not running (state: $($webApp.state))"
    Record-TestFail
}

# Test 5: Runtime Configuration
Write-TestHeader "Test 5: Runtime Configuration"
$runtime = $webApp.siteConfig.linuxFxVersion
if ($runtime -like "*DOTNETCORE*" -or $runtime -like "*DOTNET*") {
    Write-TestPass "Runtime configured: $runtime"
    Record-TestPass
    
    if ($runtime -like "*9.0*") {
        Write-TestPass ".NET 9 runtime detected"
    } elseif ($runtime -like "*8.0*") {
        Write-TestWarn ".NET 8 runtime detected (expected .NET 9)"
        Record-Warning
    } else {
        Write-TestWarn "Unexpected runtime version: $runtime"
        Record-Warning
    }
} else {
    Write-TestFail "Invalid runtime configuration: $runtime"
    Record-TestFail
}

# Test 6: HTTPS Configuration
Write-TestHeader "Test 6: HTTPS Configuration"
if ($webApp.httpsOnly) {
    Write-TestPass "HTTPS-only is enabled"
    Record-TestPass
} else {
    Write-TestWarn "HTTPS-only is not enabled (recommended for production)"
    Record-Warning
}

# Test 7: Health Endpoint
Write-TestHeader "Test 7: Health Endpoint"
$healthUrl = "https://$($webApp.defaultHostName)/health"
try {
    Write-TestInfo "Checking: $healthUrl"
    $response = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 15 -SkipCertificateCheck -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-TestPass "Health endpoint responded: $($response.StatusCode) $($response.StatusDescription)"
        Write-TestInfo "Response: $($response.Content.Substring(0, [Math]::Min(100, $response.Content.Length)))"
        Record-TestPass
    } else {
        Write-TestWarn "Health endpoint returned: $($response.StatusCode)"
        Record-Warning
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 404) {
        Write-TestWarn "Health endpoint not found (404) - may not be implemented"
        Record-Warning
    } else {
        Write-TestFail "Health endpoint failed: $($_.Exception.Message)"
        Record-TestFail
    }
}

# Test 8: Root Endpoint
Write-TestHeader "Test 8: Root Application Endpoint"
$rootUrl = "https://$($webApp.defaultHostName)/"
try {
    Write-TestInfo "Checking: $rootUrl"
    $response = Invoke-WebRequest -Uri $rootUrl -Method Get -TimeoutSec 15 -SkipCertificateCheck -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-TestPass "Application is responding: $($response.StatusCode)"
        Record-TestPass
    } else {
        Write-TestWarn "Application returned: $($response.StatusCode)"
        Record-Warning
    }
} catch {
    Write-TestFail "Application endpoint failed: $($_.Exception.Message)"
    Record-TestFail
}

# Test 9: Swagger Endpoint
Write-TestHeader "Test 9: Swagger UI"
$swaggerUrl = "https://$($webApp.defaultHostName)/swagger"
try {
    Write-TestInfo "Checking: $swaggerUrl"
    $response = Invoke-WebRequest -Uri $swaggerUrl -Method Get -TimeoutSec 15 -SkipCertificateCheck -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-TestPass "Swagger UI is accessible"
        Record-TestPass
    } else {
        Write-TestWarn "Swagger returned: $($response.StatusCode)"
        Record-Warning
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 404) {
        Write-TestWarn "Swagger UI not found (may be disabled in production)"
        Record-Warning
    } else {
        Write-TestWarn "Swagger UI check failed: $($_.Exception.Message)"
        Record-Warning
    }
}

# Test 10: Application Settings
Write-TestHeader "Test 10: Application Settings"
try {
    $settings = az webapp config appsettings list --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    Write-TestPass "Retrieved $($settings.Count) application settings"
    Record-TestPass
    
    # Check for critical settings
    $criticalSettings = @(
        "ASPNETCORE_ENVIRONMENT",
        "WEBSITE_RUN_FROM_PACKAGE"
    )
    
    $foundSettings = 0
    foreach ($setting in $criticalSettings) {
        if ($settings.name -contains $setting) {
            $foundSettings++
        }
    }
    
    if ($foundSettings -gt 0) {
        Write-TestInfo "Found $foundSettings critical settings"
    }
    
} catch {
    Write-TestFail "Failed to retrieve application settings"
    Record-TestFail
}

# Test 11: Managed Identity
Write-TestHeader "Test 11: Managed Identity"
if ($webApp.identity -and $webApp.identity.type -eq "SystemAssigned") {
    Write-TestPass "System-assigned managed identity is enabled"
    Write-TestInfo "Principal ID: $($webApp.identity.principalId)"
    Record-TestPass
} else {
    Write-TestWarn "Managed identity is not configured"
    Record-Warning
}

# Test 12: Deployment History
Write-TestHeader "Test 12: Deployment History"
try {
    $deployments = az webapp deployment list --name $WebAppName --resource-group $ResourceGroup 2>$null | ConvertFrom-Json
    if ($deployments -and $deployments.Count -gt 0) {
        $latest = $deployments | Sort-Object received_time -Descending | Select-Object -First 1
        Write-TestPass "Found deployment history ($($deployments.Count) deployments)"
        Write-TestInfo "Latest deployment: $($latest.received_time)"
        
        if ($latest.status -eq 4) {
            Write-TestInfo "Latest deployment status: Success"
        } else {
            Write-TestWarn "Latest deployment status: $($latest.status)"
            Record-Warning
        }
        Record-TestPass
    } else {
        Write-TestInfo "No deployment history found"
    }
} catch {
    Write-TestInfo "Unable to retrieve deployment history"
}

# Summary
Write-Host ""
Write-Host "??????????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host "?                   Test Summary                             ?" -ForegroundColor Cyan
Write-Host "??????????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Total Tests     : $script:totalTests" -ForegroundColor White
Write-Host "  Passed          : $script:passedTests" -ForegroundColor Green
Write-Host "  Failed          : $script:failedTests" -ForegroundColor $(if($script:failedTests -gt 0){'Red'}else{'Green'})
Write-Host "  Warnings        : $script:warnings" -ForegroundColor Yellow
Write-Host ""

if ($script:failedTests -eq 0) {
    if ($script:warnings -eq 0) {
        Write-Host "? All tests passed! Deployment is healthy." -ForegroundColor Green
        $exitCode = 0
    } else {
        Write-Host "??  Tests passed with $script:warnings warning(s). Review warnings above." -ForegroundColor Yellow
        $exitCode = 0
    }
} else {
    Write-Host "? $script:failedTests test(s) failed. Deployment may have issues." -ForegroundColor Red
    $exitCode = 1
}

Write-Host ""
Write-Host "Application URLs:" -ForegroundColor Cyan
Write-Host "  Main App   : https://$($webApp.defaultHostName)" -ForegroundColor White
Write-Host "  Health     : https://$($webApp.defaultHostName)/health" -ForegroundColor White
Write-Host "  Swagger    : https://$($webApp.defaultHostName)/swagger" -ForegroundColor White
Write-Host ""

exit $exitCode
