#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Quick deployment script for HelloWorld environment.

.DESCRIPTION
    Deploys to HelloWorld environment with HelloWorld configuration.
    This is a convenience wrapper around deploy-to-webapp.ps1

.PARAMETER ResourceGroup
    Override the default HelloWorld resource group.
    Default: HelloWord-rg

.PARAMETER WebAppName
    Override the default HelloWorld web app name.
    Default: a365001-ow65un7

.PARAMETER ForceLogin
    Force Azure logout and fresh login before deployment.

.EXAMPLE
    .\deploy-helloworld.ps1
    Deploy to HelloWorld using default settings

.EXAMPLE
    .\deploy-helloworld.ps1 -ForceLogin
    Deploy to HelloWorld with fresh Azure login
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ResourceGroup = "HelloWord-rg",
    
    [Parameter(Mandatory=$false)]
    [string]$WebAppName = "a365001-ow65un7",
    
    [Parameter(Mandatory=$false)]
    [switch]$ForceLogin
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployScript = Join-Path $ScriptDir "deploy-to-webapp.ps1"

Write-Host ""
Write-Host "?? Deploying to HELLOWORLD Environment" -ForegroundColor Cyan
Write-Host ""

$params = @{
    Configuration = "HelloWorld"
    Environment = "HelloWorld"
    ResourceGroup = $ResourceGroup
    WebAppName = $WebAppName
}

if ($ForceLogin) {
    $params.Add("ForceLogin", $true)
}

& $DeployScript @params
