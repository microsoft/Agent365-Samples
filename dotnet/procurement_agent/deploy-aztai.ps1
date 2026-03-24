#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Quick deployment script for AzTai environment.

.DESCRIPTION
    Deploys to AzTai environment with AzTai configuration.
    This is a convenience wrapper around deploy-to-webapp.ps1

.PARAMETER ResourceGroup
    Override the default AzTai resource group.

.PARAMETER WebAppName
    Override the default AzTai web app name.

.PARAMETER ForceLogin
    Force Azure logout and fresh login before deployment.

.EXAMPLE
    .\deploy-aztai.ps1
    Deploy to AzTai using default settings

.EXAMPLE
    .\deploy-aztai.ps1 -ForceLogin
    Deploy to AzTai with fresh Azure login
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ResourceGroup = "aztai-rg",
    
    [Parameter(Mandatory=$false)]
    [string]$WebAppName = "zava-procurement-aztai-webapp",
    
    [Parameter(Mandatory=$false)]
    [switch]$ForceLogin
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployScript = Join-Path $ScriptDir "deploy-to-webapp.ps1"

Write-Host ""
Write-Host "?? Deploying to AZTAI Environment" -ForegroundColor Cyan
Write-Host ""

$params = @{
    Configuration = "Release"
    Environment = "AzTai"
    ResourceGroup = $ResourceGroup
    WebAppName = $WebAppName
}

if ($ForceLogin) {
    $params.Add("ForceLogin", $true)
}

& $DeployScript @params
