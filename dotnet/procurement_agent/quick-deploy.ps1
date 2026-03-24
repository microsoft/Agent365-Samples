#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Quick deployment script for Procurement Agent (minimal output)

.DESCRIPTION
    Simplified deployment script for fast iterations. Builds and deploys in one command.

.EXAMPLE
    .\quick-deploy.ps1
#>

param(
    [string]$ResourceGroup = "helloworld-rg",
    [string]$WebAppName = "zava-procurement-webapp"
)

$ErrorActionPreference = "Stop"

Write-Host "?? Quick Deploy to $WebAppName" -ForegroundColor Cyan

# Build & Publish
Write-Host "?? Building..." -ForegroundColor Yellow
dotnet publish ProcurementA365Agent.csproj -c Release -o publish --nologo -v quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "? Build failed" -ForegroundColor Red
    exit 1
}

# Create ZIP
Write-Host "?? Packaging..." -ForegroundColor Yellow
if (Test-Path deploy.zip) { Remove-Item deploy.zip -Force }
Compress-Archive -Path "publish\*" -DestinationPath deploy.zip -Force

# Deploy
Write-Host "??  Deploying..." -ForegroundColor Yellow
az webapp deployment source config-zip `
    --resource-group $ResourceGroup `
    --name $WebAppName `
    --src deploy.zip `
    --output none

if ($LASTEXITCODE -ne 0) {
    Write-Host "? Deployment failed" -ForegroundColor Red
    exit 1
}

Write-Host "? Deployed successfully!" -ForegroundColor Green
Write-Host "?? https://$WebAppName.azurewebsites.net" -ForegroundColor Cyan
