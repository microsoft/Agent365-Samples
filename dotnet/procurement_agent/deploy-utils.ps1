#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deployment utility script with common tasks

.DESCRIPTION
    Provides quick commands for common deployment-related tasks

.PARAMETER Task
    The task to perform:
    - info: Show web app information
    - logs: Stream application logs
    - restart: Restart the web app
    - config: Show app settings
    - browse: Open web app in browser
    - status: Check deployment status

.EXAMPLE
    .\deploy-utils.ps1 -Task info
    .\deploy-utils.ps1 -Task logs
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("info", "logs", "restart", "config", "browse", "status", "help")]
    [string]$Task,
    
    [string]$ResourceGroup = "helloworld-rg",
    [string]$WebAppName = "zava-procurement-webapp"
)

$ErrorActionPreference = "Stop"

function Show-Help {
    Write-Host "`n?? Deployment Utilities Help" -ForegroundColor Cyan
    Write-Host "================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Available tasks:" -ForegroundColor Yellow
    Write-Host "  info      - Show web app information"
    Write-Host "  logs      - Stream application logs (Ctrl+C to exit)"
    Write-Host "  restart   - Restart the web app"
    Write-Host "  config    - Show application settings"
    Write-Host "  browse    - Open web app in default browser"
    Write-Host "  status    - Check deployment and runtime status"
    Write-Host "  help      - Show this help message"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Yellow
    Write-Host "  .\deploy-utils.ps1 -Task info"
    Write-Host "  .\deploy-utils.ps1 -Task logs"
    Write-Host "  .\deploy-utils.ps1 -Task status"
    Write-Host ""
}

function Show-Info {
    Write-Host "`n?? Web App Information" -ForegroundColor Cyan
    Write-Host "======================" -ForegroundColor Cyan
    
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    
    Write-Host ""
    Write-Host "Basic Information:" -ForegroundColor Yellow
    Write-Host "  Name              : $($webApp.name)"
    Write-Host "  Resource Group    : $($webApp.resourceGroup)"
    Write-Host "  Location          : $($webApp.location)"
    Write-Host "  State             : $($webApp.state)" -ForegroundColor $(if($webApp.state -eq 'Running'){'Green'}else{'Red'})
    Write-Host "  Default Hostname  : $($webApp.defaultHostName)"
    Write-Host "  HTTPS Only        : $($webApp.httpsOnly)"
    Write-Host ""
    Write-Host "Runtime Configuration:" -ForegroundColor Yellow
    Write-Host "  Platform          : $($webApp.kind)"
    Write-Host "  Runtime Stack     : $($webApp.siteConfig.linuxFxVersion)"
    Write-Host "  Always On         : $($webApp.siteConfig.alwaysOn)"
    Write-Host ""
    Write-Host "App Service Plan:" -ForegroundColor Yellow
    $planId = $webApp.serverFarmId.Split('/')[-1]
    Write-Host "  Plan Name         : $planId"
    Write-Host ""
    Write-Host "URLs:" -ForegroundColor Yellow
    Write-Host "  Application       : https://$($webApp.defaultHostName)"
    Write-Host "  Health Check      : https://$($webApp.defaultHostName)/health"
    Write-Host "  Swagger           : https://$($webApp.defaultHostName)/swagger"
    Write-Host ""
}

function Show-Logs {
    Write-Host "`n?? Streaming Application Logs" -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to exit" -ForegroundColor Yellow
    Write-Host ""
    
    az webapp log tail --name $WebAppName --resource-group $ResourceGroup
}

function Restart-WebApp {
    Write-Host "`n?? Restarting Web App" -ForegroundColor Cyan
    
    az webapp restart --name $WebAppName --resource-group $ResourceGroup --output none
    
    Write-Host "? Web app restarted successfully" -ForegroundColor Green
    Write-Host ""
    Write-Host "Waiting for app to start (10 seconds)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 10
    
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    Write-Host "Current state: $($webApp.state)" -ForegroundColor $(if($webApp.state -eq 'Running'){'Green'}else{'Red'})
    Write-Host ""
}

function Show-Config {
    Write-Host "`n??  Application Settings" -ForegroundColor Cyan
    Write-Host "=======================" -ForegroundColor Cyan
    Write-Host ""
    
    $settings = az webapp config appsettings list --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    
    $settings | Sort-Object name | ForEach-Object {
        $value = $_.value
        # Mask sensitive values
        if ($_.name -match "Key|Secret|Password|Token|ConnectionString") {
            $value = "***MASKED***"
        }
        Write-Host "  $($_.name.PadRight(40)) = $value"
    }
    
    Write-Host ""
    Write-Host "Total settings: $($settings.Count)" -ForegroundColor Yellow
    Write-Host ""
}

function Open-Browser {
    Write-Host "`n?? Opening Web App in Browser" -ForegroundColor Cyan
    
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    $url = "https://$($webApp.defaultHostName)"
    
    Write-Host "Opening: $url" -ForegroundColor Yellow
    
    if ($IsWindows -or $env:OS -like "*Windows*") {
        Start-Process $url
    } elseif ($IsMacOS) {
        open $url
    } else {
        xdg-open $url
    }
    
    Write-Host "? Browser opened" -ForegroundColor Green
    Write-Host ""
}

function Show-Status {
    Write-Host "`n?? Deployment & Runtime Status" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    # Web App Status
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    
    Write-Host "Runtime Status:" -ForegroundColor Yellow
    Write-Host "  State             : $($webApp.state)" -ForegroundColor $(if($webApp.state -eq 'Running'){'Green'}else{'Red'})
    Write-Host "  Availability      : $($webApp.availabilityState)"
    Write-Host ""
    
    # Latest Deployment
    Write-Host "Latest Deployment:" -ForegroundColor Yellow
    try {
        $deployments = az webapp deployment list --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
        if ($deployments -and $deployments.Count -gt 0) {
            $latest = $deployments | Sort-Object received_time -Descending | Select-Object -First 1
            Write-Host "  Status            : $($latest.status)" -ForegroundColor $(if($latest.status -eq 4){'Green'}else{'Yellow'})
            Write-Host "  Time              : $($latest.received_time)"
            Write-Host "  Author            : $($latest.author)"
            Write-Host "  Message           : $($latest.message)"
        } else {
            Write-Host "  No deployment history found" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  Unable to retrieve deployment history" -ForegroundColor Gray
    }
    Write-Host ""
    
    # Health Check
    Write-Host "Health Check:" -ForegroundColor Yellow
    try {
        $healthUrl = "https://$($webApp.defaultHostName)/health"
        Write-Host "  Endpoint          : $healthUrl"
        
        $response = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 10 -SkipCertificateCheck -ErrorAction SilentlyContinue
        Write-Host "  Status            : $($response.StatusCode) $($response.StatusDescription)" -ForegroundColor Green
    } catch {
        Write-Host "  Status            : Unreachable or no health endpoint" -ForegroundColor Yellow
    }
    Write-Host ""
    
    # URLs
    Write-Host "Access Points:" -ForegroundColor Yellow
    Write-Host "  Application       : https://$($webApp.defaultHostName)"
    Write-Host "  Swagger           : https://$($webApp.defaultHostName)/swagger"
    Write-Host ""
}

# Main execution
Write-Host ""
Write-Host "?? Deployment Utilities" -ForegroundColor Magenta
Write-Host "Target: $WebAppName ($ResourceGroup)" -ForegroundColor Gray
Write-Host ""

switch ($Task) {
    "info"    { Show-Info }
    "logs"    { Show-Logs }
    "restart" { Restart-WebApp }
    "config"  { Show-Config }
    "browse"  { Open-Browser }
    "status"  { Show-Status }
    "help"    { Show-Help }
}
