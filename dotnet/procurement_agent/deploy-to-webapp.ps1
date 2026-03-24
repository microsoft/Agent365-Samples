#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploys the Procurement Agent to an existing Azure Web App.

.DESCRIPTION
    This script builds, publishes, and deploys the ProcurementA365Agent to an existing
    Azure Web App. It handles the complete deployment pipeline including:
    - Building the .NET 9 project
    - Publishing to a local folder
    - Creating a deployment ZIP
    - Deploying to Azure App Service

.PARAMETER ResourceGroup
    The Azure resource group containing the web app.
    Default: helloworld-rg

.PARAMETER WebAppName
    The name of the Azure Web App to deploy to.
    Default: zava-procurement-webapp

.PARAMETER Configuration
    The build configuration (Debug or Release).
    Default: Release

.PARAMETER Environment
    The deployment environment (e.g., Development, Preview, Production).
    This parameter is optional and used for informational purposes.

.PARAMETER SkipBuild
    Skip the build and publish steps (use existing publish folder).

.PARAMETER Verbose
    Enable verbose logging.

.PARAMETER ForceLogin
    Force logout and re-login to Azure CLI before deployment.

.EXAMPLE
    .\deploy-to-webapp.ps1
    Deploy using default settings (helloworld-rg/zava-procurement-webapp)

.EXAMPLE
    .\deploy-to-webapp.ps1 -ResourceGroup "my-rg" -WebAppName "my-webapp"
    Deploy to a different resource group and web app

.EXAMPLE
    .\deploy-to-webapp.ps1 -Configuration Debug -Verbose
    Deploy a Debug build with verbose logging

.EXAMPLE
    .\deploy-to-webapp.ps1 -SkipBuild
    Skip build and deploy from existing publish folder

.EXAMPLE
    .\deploy-to-webapp.ps1 -ForceLogin
    Force logout and re-login to Azure CLI before deployment

.EXAMPLE
    .\deploy-to-webapp.ps1 -Environment Production
    Deploy to Production environment
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ResourceGroup = "helloworld-rg",
    
    [Parameter(Mandatory=$false)]
    [string]$WebAppName = "zava-procurement-webapp",
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    
    [Parameter(Mandatory=$false)]
    [string]$Environment = "",
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipBuild,
    
    [Parameter(Mandatory=$false)]
    [switch]$CleanPublish,
    
    [Parameter(Mandatory=$false)]
    [switch]$ForceLogin
)

# Script configuration
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectFile = Join-Path $ScriptDir "ProcurementA365Agent.csproj"
$PublishDir = Join-Path $ScriptDir "publish"
$DeployZip = Join-Path $ScriptDir "deploy.zip"

# Color output functions
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function Write-Success {
    param([string]$Message)
    Write-ColorOutput "? $Message" "Green"
}

function Write-Info {
    param([string]$Message)
    Write-ColorOutput "??  $Message" "Cyan"
}

function Write-Warning {
    param([string]$Message)
    Write-ColorOutput "??  $Message" "Yellow"
}

function Write-Error {
    param([string]$Message)
    Write-ColorOutput "? $Message" "Red"
}

function Write-Step {
    param([string]$Message)
    Write-ColorOutput "`n=== $Message ===" "Magenta"
}

# Banner
Write-Host ""
Write-ColorOutput "??????????????????????????????????????????????????????????????" "Cyan"
Write-ColorOutput "?       Procurement Agent Deployment Script                 ?" "Cyan"
Write-ColorOutput "??????????????????????????????????????????????????????????????" "Cyan"
Write-Host ""

# Display configuration
Write-Info "Configuration:"
Write-Host "  Resource Group : $ResourceGroup"
Write-Host "  Web App Name   : $WebAppName"
Write-Host "  Build Config   : $Configuration"
if ($Environment) {
    Write-Host "  Environment    : $Environment"
}
Write-Host "  Project File   : $ProjectFile"
Write-Host "  Publish Dir    : $PublishDir"
Write-Host ""

# Prerequisites check
Write-Step "Checking Prerequisites"

# Check if project file exists
if (-not (Test-Path $ProjectFile)) {
    Write-Error "Project file not found: $ProjectFile"
    exit 1
}
Write-Success "Project file found"

# Check if dotnet CLI is available
try {
    $dotnetVersion = dotnet --version
    Write-Success "dotnet CLI found (version: $dotnetVersion)"
} catch {
    Write-Error "dotnet CLI not found. Please install .NET SDK 9.0 or later."
    Write-Info "Download from: https://dotnet.microsoft.com/download"
    exit 1
}

# Check if Azure CLI is available
try {
    $azVersion = az version --query '"azure-cli"' -o tsv 2>$null
    Write-Success "Azure CLI found (version: $azVersion)"
} catch {
    Write-Error "Azure CLI not found. Please install Azure CLI."
    Write-Info "Download from: https://docs.microsoft.com/cli/azure/install-azure-cli"
    exit 1
}

# Check Azure CLI login status
Write-Info "Checking Azure CLI authentication..."
try {
    $account = az account show 2>$null | ConvertFrom-Json
    if ($account) {
        Write-Success "Logged in to Azure as: $($account.user.name)"
        Write-Info "Subscription: $($account.name) ($($account.id))"
        
        # Ask if user wants to force logout and re-login
        if (-not $ForceLogin) {
            $forceLogout = Read-Host "`nDo you want to logout and login again with a different account? (y/N)"
            if ($forceLogout -eq 'y' -or $forceLogout -eq 'Y') {
                $ForceLogin = $true
            }
        }
        
        if ($ForceLogin) {
            Write-Info "Logging out from Azure..."
            az logout
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Logged out successfully"
            }
            
            Write-Info "Logging in to Azure..."
            az login
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Azure login failed"
                exit 1
            }
            
            # Show new account info
            $account = az account show | ConvertFrom-Json
            Write-Success "Logged in to Azure as: $($account.user.name)"
            Write-Info "Subscription: $($account.name) ($($account.id))"
        }
    } else {
        Write-Warning "Not logged in to Azure. Running 'az login'..."
        az login
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Azure login failed"
            exit 1
        }
    }
} catch {
    Write-Warning "Unable to verify Azure login. Attempting login..."
    az login
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Azure login failed"
        exit 1
    }
}

# Verify web app exists
Write-Step "Verifying Azure Resources"
Write-Info "Checking if web app exists: $WebAppName"
try {
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup 2>$null | ConvertFrom-Json
    if ($webApp) {
        Write-Success "Web app found: $WebAppName"
        Write-Info "  Location: $($webApp.location)"
        Write-Info "  State: $($webApp.state)"
        Write-Info "  Default Hostname: $($webApp.defaultHostName)"
        Write-Info "  Runtime: $($webApp.siteConfig.linuxFxVersion)"
    } else {
        Write-Error "Web app '$WebAppName' not found in resource group '$ResourceGroup'"
        exit 1
    }
} catch {
    Write-Error "Failed to verify web app. Error: $_"
    Write-Info "Please ensure the web app exists and you have access to it."
    exit 1
}

# Build and Publish
if (-not $SkipBuild) {
    Write-Step "Building and Publishing Project"
    
    # Clean publish directory if requested
    if ($CleanPublish -and (Test-Path $PublishDir)) {
        Write-Info "Cleaning publish directory..."
        Remove-Item -Path $PublishDir -Recurse -Force
        Write-Success "Publish directory cleaned"
    }
    
    # Restore dependencies
    Write-Info "Restoring NuGet packages..."
    dotnet restore $ProjectFile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet restore failed"
        exit 1
    }
    Write-Success "NuGet packages restored"
    
    # Build project
    Write-Info "Building project ($Configuration)..."
    dotnet build $ProjectFile --configuration $Configuration --no-restore
    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet build failed"
        exit 1
    }
    Write-Success "Project built successfully"
    
    # Publish project
    Write-Info "Publishing project to: $PublishDir"
    dotnet publish $ProjectFile `
        --configuration $Configuration `
        --output $PublishDir `
        --no-build
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet publish failed"
        exit 1
    }
    Write-Success "Project published successfully"
    
    # Display publish directory contents
    $publishedFiles = Get-ChildItem -Path $PublishDir -Recurse -File
    Write-Info "Published $($publishedFiles.Count) files"
} else {
    Write-Warning "Skipping build (using existing publish folder)"
    
    if (-not (Test-Path $PublishDir)) {
        Write-Error "Publish directory not found: $PublishDir"
        Write-Info "Run without -SkipBuild to build the project first"
        exit 1
    }
}

# Create deployment ZIP
Write-Step "Creating Deployment Package"

# Remove existing ZIP if it exists
if (Test-Path $DeployZip) {
    Write-Info "Removing existing deployment ZIP..."
    Remove-Item -Path $DeployZip -Force
}

Write-Info "Creating ZIP archive..."
try {
    # Create ZIP from publish directory
    Compress-Archive -Path "$PublishDir\*" -DestinationPath $DeployZip -Force
    
    $zipSize = (Get-Item $DeployZip).Length / 1MB
    Write-Success "Deployment package created: $DeployZip"
    Write-Info "  Size: $([math]::Round($zipSize, 2)) MB"
} catch {
    Write-Error "Failed to create deployment ZIP: $_"
    exit 1
}

# Deploy to Azure
Write-Step "Deploying to Azure Web App"

Write-Info "Deploying to: $WebAppName"
Write-Info "This may take a few minutes..."

try {
    # Deploy using az webapp deployment
    az webapp deployment source config-zip `
        --resource-group $ResourceGroup `
        --name $WebAppName `
        --src $DeployZip `
        --timeout 600
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Deployment failed"
        exit 1
    }
    
    Write-Success "Deployment completed successfully!"
} catch {
    Write-Error "Deployment failed: $_"
    exit 1
}

# Post-deployment verification
Write-Step "Post-Deployment Verification"

Write-Info "Waiting for app to start (15 seconds)..."
Start-Sleep -Seconds 15

Write-Info "Checking web app status..."
try {
    $webApp = az webapp show --name $WebAppName --resource-group $ResourceGroup | ConvertFrom-Json
    Write-Success "Web app state: $($webApp.state)"
    
    if ($webApp.state -eq "Running") {
        Write-Success "Web app is running"
        Write-Info "Application URL: https://$($webApp.defaultHostName)"
        Write-Info "Health Check: https://$($webApp.defaultHostName)/health"
    } else {
        Write-Warning "Web app state is not 'Running': $($webApp.state)"
    }
} catch {
    Write-Warning "Could not verify web app status: $_"
}

# Display logs info
Write-Step "Deployment Complete"
Write-Success "? Deployment finished successfully!"
Write-Host ""
Write-Info "Next steps:"
Write-Host "  1. Visit your web app: https://$($webApp.defaultHostName)"
Write-Host "  2. Check health endpoint: https://$($webApp.defaultHostName)/health"
Write-Host "  3. View logs in Azure Portal or use: az webapp log tail --name $WebAppName --resource-group $ResourceGroup"
Write-Host ""

# Offer to open logs
$openLogs = Read-Host "Do you want to stream logs now? (y/N)"
if ($openLogs -eq 'y' -or $openLogs -eq 'Y') {
    Write-Info "Starting log stream (Press Ctrl+C to exit)..."
    az webapp log tail --name $WebAppName --resource-group $ResourceGroup
}

Write-Host ""
Write-ColorOutput "??????????????????????????????????????????????????????????????" "Green"
Write-ColorOutput "?              Deployment Successfully Completed             ?" "Green"
Write-ColorOutput "??????????????????????????????????????????????????????????????" "Green"
Write-Host ""
