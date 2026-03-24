#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Quick deployment script for Preview environment.

.DESCRIPTION
    Deploys to Preview environment with Preview configuration.
    By default, deploys only to prod-5u3zwee.
    Optional deployments to procurement-zava and Procurement-hello-world can be enabled with flags.
    
    This is a convenience wrapper around deploy-to-webapp.ps1

.PARAMETER ResourceGroup
    Override the default Preview resource group.

.PARAMETER WebAppName
    Override the default Preview web app name (prod-5u3zwee).

.PARAMETER ZavaWebAppName
    Override the procurement-zava web app name (used with -IncludeZava).

.PARAMETER HelloWorldWebAppName
    Override the Procurement-hello-world web app name (used with -IncludeHelloWorld).

.PARAMETER ForceLogin
    Force Azure logout and fresh login before deployment.

.PARAMETER IncludeZava
    Include deployment to procurement-zava web app.

.PARAMETER IncludeHelloWorld
    Include deployment to Procurement-hello-world web app.

.EXAMPLE
    .\deploy-preview.ps1
    Deploy to Preview (prod-5u3zwee only)

.EXAMPLE
    .\deploy-preview.ps1 -IncludeZava -IncludeHelloWorld
    Deploy to all three web apps

.EXAMPLE
    .\deploy-preview.ps1 -IncludeZava
    Deploy to prod-5u3zwee and procurement-zava

.EXAMPLE
    .\deploy-preview.ps1 -ForceLogin
    Deploy to Preview with fresh Azure login
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ResourceGroup = "procurement-resource",
    
    [Parameter(Mandatory=$false)]
    [string]$WebAppName = "prod-5u3zwee",
    
    [Parameter(Mandatory=$false)]
    [string]$ZavaWebAppName = "procurement-zava",
    
    [Parameter(Mandatory=$false)]
    [string]$HelloWorldWebAppName = "Procurement-hello-world",
    
    [Parameter(Mandatory=$false)]
    [switch]$ForceLogin,
    
    [Parameter(Mandatory=$false)]
    [switch]$IncludeZava,
    
    [Parameter(Mandatory=$false)]
    [switch]$IncludeHelloWorld
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployScript = Join-Path $ScriptDir "deploy-to-webapp.ps1"

# Calculate total deployments
$totalDeployments = 1
if ($IncludeZava) { $totalDeployments++ }
if ($IncludeHelloWorld) { $totalDeployments++ }

Write-Host ""
Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host "?     Deploying to PREVIEW Environment ($totalDeployments Web App$(if ($totalDeployments -gt 1) { 's' }))      ?" -ForegroundColor Cyan
Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host ""

# Track overall success
$deploymentSuccess = $true
$currentDeployment = 0

# Deploy to primary web app (prod-5u3zwee)
$currentDeployment++
Write-Host ""
Write-Host "? DEPLOYMENT $currentDeployment of ${totalDeployments}: Primary Web App (prod-5u3zwee)" -ForegroundColor Yellow
Write-Host "  Web App: $WebAppName" -ForegroundColor Yellow
Write-Host "  Configuration: appsettings.preview.json" -ForegroundColor Yellow
Write-Host ""

$params1 = @{
    Configuration = "Release"
    Environment = "Production"
    ResourceGroup = $ResourceGroup
    WebAppName = $WebAppName
}

if ($ForceLogin) {
    $params1.Add("ForceLogin", $true)
}

try {
    & $DeployScript @params1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "? Deployment to $WebAppName failed" -ForegroundColor Red
        $deploymentSuccess = $false
    } else {
        Write-Host "? Deployment to $WebAppName completed successfully" -ForegroundColor Green
    }
} catch {
    Write-Host "? Deployment to $WebAppName failed with error: $_" -ForegroundColor Red
    $deploymentSuccess = $false
}

# Deploy to procurement-zava (if included)
if ($IncludeZava) {
    $currentDeployment++
    Write-Host ""
    Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "? DEPLOYMENT $currentDeployment of ${totalDeployments}: Procurement Zava Web App" -ForegroundColor Yellow
    Write-Host "  Web App: $ZavaWebAppName" -ForegroundColor Yellow
    Write-Host "  Configuration: appsettings.procurement-zava.json" -ForegroundColor Yellow
    Write-Host ""

    $params2 = @{
        Configuration = "Release"
        Environment = "Production"
        ResourceGroup = $ResourceGroup
        WebAppName = $ZavaWebAppName
        SkipBuild = $true  # Reuse the build from first deployment
    }

    try {
        & $DeployScript @params2
        if ($LASTEXITCODE -ne 0) {
            Write-Host "? Deployment to $ZavaWebAppName failed" -ForegroundColor Red
            $deploymentSuccess = $false
        } else {
            Write-Host "? Deployment to $ZavaWebAppName completed successfully" -ForegroundColor Green
        }
    } catch {
        Write-Host "? Deployment to $ZavaWebAppName failed with error: $_" -ForegroundColor Red
        $deploymentSuccess = $false
    }
}

# Deploy to hello world web app (if included)
if ($IncludeHelloWorld) {
    $currentDeployment++
    Write-Host ""
    Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "? DEPLOYMENT $currentDeployment of ${totalDeployments}: Hello World Web App" -ForegroundColor Yellow
    Write-Host "  Web App: $HelloWorldWebAppName" -ForegroundColor Yellow
    Write-Host ""

    $params3 = @{
        Configuration = "Release"
        Environment = "Production"
        ResourceGroup = $ResourceGroup
        WebAppName = $HelloWorldWebAppName
        SkipBuild = $true  # Reuse the build from first deployment
    }

    try {
        & $DeployScript @params3
        if ($LASTEXITCODE -ne 0) {
            Write-Host "? Deployment to $HelloWorldWebAppName failed" -ForegroundColor Red
            $deploymentSuccess = $false
        } else {
            Write-Host "? Deployment to $HelloWorldWebAppName completed successfully" -ForegroundColor Green
        }
    } catch {
        Write-Host "? Deployment to $HelloWorldWebAppName failed with error: $_" -ForegroundColor Red
        $deploymentSuccess = $false
    }
}

# Final summary
Write-Host ""
Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host "?              DEPLOYMENT SUMMARY                         ?" -ForegroundColor Cyan
Write-Host "???????????????????????????????????????????????????????????" -ForegroundColor Cyan
Write-Host ""

if ($deploymentSuccess) {
    Write-Host "? All deployments completed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Deployed to:" -ForegroundColor Cyan
    Write-Host "  1. $WebAppName (Primary - prod-5u3zwee)" -ForegroundColor White
    if ($IncludeZava) {
        Write-Host "  2. $ZavaWebAppName (Zava)" -ForegroundColor White
    }
    if ($IncludeHelloWorld) {
        Write-Host "  $($IncludeZava ? '3' : '2'). $HelloWorldWebAppName (Hello World)" -ForegroundColor White
    }
    
    if (-not $IncludeZava -and -not $IncludeHelloWorld) {
        Write-Host ""
        Write-Host "?? Tip: Use -IncludeZava or -IncludeHelloWorld flags to deploy to additional web apps" -ForegroundColor Cyan
    }
} else {
    Write-Host "? One or more deployments failed. Please check the logs above." -ForegroundColor Red
    exit 1
}

Write-Host ""
