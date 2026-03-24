#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Comprehensive setup for Agent365 LocalEvalRunner evaluation environment

.DESCRIPTION
    This script sets up the complete LocalEvalRunner evaluation environment following the official
    installation guide. It installs LocalEvalRunner as a .NET tool from the Azure DevOps NuGet feed
    and verifies the installation. Project initialization happens automatically on first evaluation run.

.PARAMETER skipInstall
    Skip the installation/update of LocalEvalRunner (for testing or when already installed)

.EXAMPLE
    .\setup.ps1
    Install LocalEvalRunner and verify evaluation environment

.EXAMPLE
    .\setup.ps1 -skipInstall
    Verify existing installation without reinstalling
#>

param(
    [switch]$skipInstall
)

$ErrorActionPreference = "Stop"

# Setup paths
$BinDir = Join-Path $PSScriptRoot "bin"

# Azure DevOps NuGet feed information
$AzureDevOpsNuGetFeed = "https://pkgs.dev.azure.com/dynamicscrm/_packaging/XrmSolutions/nuget/v3/index.json"
$ToolName = "LocalEvalRunner"

Write-Host "🚀 Agent365 LocalEvalRunner Setup" -ForegroundColor Green
Write-Host "==================================" -ForegroundColor Green
Write-Host ""
Write-Host "This script will install LocalEvalRunner as a .NET tool following the official guide:" -ForegroundColor Gray
Write-Host "https://dev.azure.com/dynamicscrm/OneCRM/_git/LocalEvalRunner" -ForegroundColor Gray
Write-Host ""

# Create directories
Write-Host "📁 Creating required directories..." -ForegroundColor Cyan
if (!(Test-Path $BinDir)) { 
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null 
    Write-Host "   ✅ Created: $BinDir" -ForegroundColor Green
}

# Function: Check prerequisites
function Test-Prerequisites {
    Write-Host "🔍 Checking prerequisites..." -ForegroundColor Cyan
    Write-Host ""
    
    # Check .NET SDK
    Write-Host "1️⃣  Checking .NET SDK..." -ForegroundColor Yellow
    try {
        $dotnetVersion = dotnet --version 2>$null
        if ($dotnetVersion) {
            Write-Host "   ✅ .NET SDK version: $dotnetVersion" -ForegroundColor Green
            
            # Check if .NET 8.0 or later
            $majorVersion = [int]($dotnetVersion -split '\.')[0]
            if ($majorVersion -lt 8) {
                Write-Host "   ⚠️  .NET 8.0 or later is recommended (found: $dotnetVersion)" -ForegroundColor Yellow
            }
        } else {
            Write-Host "   ❌ .NET SDK not found" -ForegroundColor Red
            Write-Host "   📥 Install from: https://dotnet.microsoft.com/download" -ForegroundColor Yellow
            return $false
        }
    } catch {
        Write-Host "   ❌ .NET SDK not found" -ForegroundColor Red
        Write-Host "   📥 Install from: https://dotnet.microsoft.com/download" -ForegroundColor Yellow
        return $false
    }
    
    Write-Host ""
    
    # Check Azure CLI
    Write-Host "2️⃣  Checking Azure CLI..." -ForegroundColor Yellow
    try {
        $azVersion = az version --output json 2>$null | ConvertFrom-Json
        if ($azVersion) {
            Write-Host "   ✅ Azure CLI version: $($azVersion.'azure-cli')" -ForegroundColor Green
        } else {
            Write-Host "   ❌ Azure CLI not found" -ForegroundColor Red
            Write-Host "   📥 Install with: winget install -e --id Microsoft.AzureCLI" -ForegroundColor Yellow
            return $false
        }
    } catch {
        Write-Host "   ❌ Azure CLI not found" -ForegroundColor Red
        Write-Host "   📥 Install with: winget install -e --id Microsoft.AzureCLI" -ForegroundColor Yellow
        return $false
    }
    
    Write-Host ""
    
    # Check Azure authentication
    Write-Host "3️⃣  Checking Azure authentication..." -ForegroundColor Yellow
    try {
        $account = az account show 2>$null | ConvertFrom-Json
        if ($account) {
            Write-Host "   ✅ Authenticated as: $($account.user.name)" -ForegroundColor Green
            Write-Host "   📝 Subscription: $($account.name)" -ForegroundColor Gray
        } else {
            Write-Host "   ⚠️  Not authenticated to Azure" -ForegroundColor Yellow
            Write-Host "   🔑 Initiating Azure login..." -ForegroundColor Cyan
            Write-Host ""
            az login --output none
            
            $account = az account show 2>$null | ConvertFrom-Json
            if ($account) {
                Write-Host "   ✅ Successfully authenticated as: $($account.user.name)" -ForegroundColor Green
            } else {
                Write-Host "   ❌ Azure login failed" -ForegroundColor Red
                return $false
            }
        }
    } catch {
        Write-Host "   ❌ Azure authentication check failed" -ForegroundColor Red
        return $false
    }
    
    Write-Host ""
    
    # Check NuGet Credential Provider
    Write-Host "4️⃣  Checking NuGet Credential Provider..." -ForegroundColor Yellow
    $credProviderPath = Join-Path $env:USERPROFILE ".nuget\plugins\netcore\CredentialProvider.Microsoft"
    if (Test-Path $credProviderPath) {
        Write-Host "   ✅ NuGet Credential Provider found" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  NuGet Credential Provider not found" -ForegroundColor Yellow
        Write-Host "   📥 Installing NuGet Credential Provider..." -ForegroundColor Cyan
        try {
            $script = Invoke-RestMethod https://aka.ms/install-artifacts-credprovider.ps1
            Invoke-Expression "$script -AddNetfx"
            Write-Host "   ✅ NuGet Credential Provider installed" -ForegroundColor Green
        } catch {
            Write-Host "   ⚠️  Failed to install NuGet Credential Provider" -ForegroundColor Yellow
            Write-Host "   💡 You may need to install it manually" -ForegroundColor Gray
        }
    }
    
    Write-Host ""
    return $true
}

# Function: Install LocalEvalRunner
function Install-LocalEvalRunner {
    Write-Host "📦 Installing LocalEvalRunner..." -ForegroundColor Cyan
    Write-Host ""
    
    # Check if already installed
    Write-Host "🔍 Checking existing installation..." -ForegroundColor Yellow
    try {
        $existingTool = dotnet tool list --global | Select-String "LocalEvalRunner"
        if ($existingTool) {
            Write-Host "   ℹ️  LocalEvalRunner already installed" -ForegroundColor Blue
            Write-Host "   🔄 Updating to latest version..." -ForegroundColor Cyan
            $updateResult = dotnet tool update LocalEvalRunner --global --interactive --add-source $AzureDevOpsNuGetFeed 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "   ✅ LocalEvalRunner updated successfully" -ForegroundColor Green
                return $true
            } else {
                Write-Host "   ⚠️  Update failed, trying fresh install..." -ForegroundColor Yellow
                dotnet tool uninstall LocalEvalRunner --global 2>$null
            }
        }
    } catch {
        Write-Host "   📝 No existing installation found" -ForegroundColor Gray
    }
    
    # Install LocalEvalRunner
    Write-Host "🚀 Installing LocalEvalRunner from Azure DevOps..." -ForegroundColor Cyan
    Write-Host "   💡 This will open an interactive authentication prompt" -ForegroundColor Yellow
    Write-Host ""
    
    $installResult = dotnet tool install LocalEvalRunner --global --interactive --add-source $AzureDevOpsNuGetFeed 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ LocalEvalRunner installed successfully!" -ForegroundColor Green
        
        # Verify installation
        Write-Host "🔍 Verifying installation..." -ForegroundColor Yellow
        try {
            $version = LocalEvalRunner.exe --version 2>&1
            Write-Host "   ✅ LocalEvalRunner version: $version" -ForegroundColor Green
            return $true
        } catch {
            Write-Host "   ⚠️  LocalEvalRunner installed but not accessible in PATH" -ForegroundColor Yellow
            Write-Host "   💡 You may need to restart your terminal" -ForegroundColor Gray
            return $false
        }
    } else {
        Write-Host "   ❌ LocalEvalRunner installation failed" -ForegroundColor Red
        Write-Host "   📝 Error output: $installResult" -ForegroundColor Gray
        Write-Host ""
        Write-Host "💡 Troubleshooting:" -ForegroundColor Yellow
        Write-Host "   • Make sure you're authenticated to Azure (az login)" -ForegroundColor Gray
        Write-Host "   • Ensure NuGet Credential Provider is installed" -ForegroundColor Gray
        Write-Host "   • Check internet connectivity to Azure DevOps" -ForegroundColor Gray
        return $false
    }
}

# Function: Verify setup
function Test-Setup {
    Write-Host "🧪 Verifying setup..." -ForegroundColor Cyan
    Write-Host ""
    
    # Test LocalEvalRunner
    Write-Host "1️⃣  Testing LocalEvalRunner..." -ForegroundColor Yellow
    try {
        $version = LocalEvalRunner.exe --version 2>&1
        Write-Host "   ✅ LocalEvalRunner accessible (version: $version)" -ForegroundColor Green
    } catch {
        Write-Host "   ❌ LocalEvalRunner not accessible" -ForegroundColor Red
        return $false
    }
    
    Write-Host ""
    
    # Check directory structure
    Write-Host "2️⃣  Checking directory structure..." -ForegroundColor Yellow
    $requiredDirs = @("scenarios", "bin")
    foreach ($dir in $requiredDirs) {
        if (Test-Path $dir) {
            Write-Host "   ✅ Directory exists: $dir" -ForegroundColor Green
        } else {
            Write-Host "   ❌ Missing directory: $dir" -ForegroundColor Red
            return $false
        }
    }
    
    Write-Host ""
    Write-Host "🎉 Setup verification completed successfully!" -ForegroundColor Green
    return $true
}

# Main execution
Write-Host "🚀 LocalEvalRunner Setup Script" -ForegroundColor Magenta
Write-Host "=================================" -ForegroundColor Magenta
Write-Host ""

try {
    # Check prerequisites
    if (-not (Test-Prerequisites)) {
        Write-Host ""
        Write-Host "❌ Prerequisites not met. Please install the required components and run this script again." -ForegroundColor Red
        exit 1
    }
    
    Write-Host "✅ All prerequisites are satisfied!" -ForegroundColor Green
    Write-Host ""
    
    # Install LocalEvalRunner
    if (-not (Install-LocalEvalRunner)) {
        Write-Host ""
        Write-Host "❌ LocalEvalRunner installation failed. Please check the error messages above." -ForegroundColor Red
        exit 1
    }
    
    Write-Host ""
    
    # Verify setup
    if (-not (Test-Setup)) {
        Write-Host ""
        Write-Host "❌ Setup verification failed. Please check the error messages above." -ForegroundColor Red
        exit 1
    }
    
    # Success message
    Write-Host ""
    Write-Host "🎉 Setup completed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📋 Next steps:" -ForegroundColor Cyan
    Write-Host "   1. Configure your evaluation scenarios in the 'scenarios' directory" -ForegroundColor Gray
    Write-Host "   2. Run evaluations using: .\run-evaluation.ps1" -ForegroundColor Gray
    Write-Host ""
    Write-Host "📖 For more information, see the README.md file" -ForegroundColor Gray
    Write-Host ""
    
} catch {
    Write-Host ""
    Write-Host "❌ An unexpected error occurred: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "📝 Stack trace: $($_.ScriptStackTrace)" -ForegroundColor Gray
    exit 1
}
