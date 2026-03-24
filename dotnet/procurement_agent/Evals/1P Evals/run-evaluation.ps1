#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Runs LocalEvalRunner evaluations against Agent365 with proper configuration
.DESCRIPTION
    This script provides an easy way to run LocalEvalRunner evaluations against the Agent365 agent
    with appropriate configuration and parameters. It automatically generates agent configuration
    from source code to ensure single source of truth, handles setup, execution, and reporting.
    
    The script automatically:
    - Extracts system prompts from AgentInstructions.cs
    - Analyzes plugin source files to create mock implementations
    - Generates LocalAgentConfig files before each run
    - Synchronizes Azure OpenAI settings with parent configuration
    - Initializes project on first run using 'localevalrunner init'
    - Opens results viewer and reports after completion
    
.PARAMETER TestFile
    The test file to run evaluations against (JSON format, from common ../scenarios folder)
.PARAMETER Config
    Custom configuration file (defaults to configs/appsettings.json)
.PARAMETER Concurrency  
    Maximum concurrent AI requests (default: 3)
.PARAMETER VerboseOutput
    Show detailed command line and execution information
.EXAMPLE
    .\run-evaluation.ps1 -TestFile "agent365_basic_tests.json"
.EXAMPLE  
    .\run-evaluation.ps1 -TestFile "agent365_comprehensive_tests.json" -Concurrency 5 -VerboseOutput
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$TestFile,
    
    [string]$Config = "configs\appsettings.json",
    
    [int]$Concurrency = 3,
    
    [switch]$VerboseOutput
)

$ErrorActionPreference = "Stop"

# Get script directory for relative paths
$ScriptDir = $PSScriptRoot
$BinPath = "localevalrunner"  # LocalEvalRunner is installed globally as a dotnet tool
$ConfigPath = Join-Path $ScriptDir $Config
$TestPath = Join-Path (Split-Path $ScriptDir -Parent) "scenarios" $TestFile
$ReportsPath = Join-Path (Split-Path $ScriptDir -Parent) "reports"

Write-Host "🤖 Agent365 Evaluation Runner" -ForegroundColor Green
Write-Host "=============================" -ForegroundColor Green

# Generate agent configuration before validation
Write-Host "🔧 Generating agent configuration from source code..." -ForegroundColor Cyan
$generateScript = Join-Path (Split-Path $ScriptDir -Parent) "Generate-AgentConfig.ps1"
if (Test-Path $generateScript) {
    try {
        # Generate config in the bin folder relative to 1P Evals directory
        & $generateScript -OutputDir "1P Evals\bin\LocalAgentConfig" -Force
        Write-Host "✅ Agent configuration generated successfully" -ForegroundColor Green
    } catch {
        Write-Host "⚠️  Warning: Failed to generate agent configuration: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "   Proceeding with existing configuration files..." -ForegroundColor Gray
    }
} else {
    Write-Host "⚠️  Generate-AgentConfig.ps1 not found, using existing configuration files" -ForegroundColor Yellow
}

# Copy CustomEvaluators folder to bin directory
Write-Host "📦 Copying custom evaluators to bin directory..." -ForegroundColor Cyan
$customEvaluatorsSource = Join-Path $ScriptDir "configs\CustomEvaluators"
$customEvaluatorsDest = Join-Path $ScriptDir "bin\CustomEvaluators"

if (Test-Path $customEvaluatorsSource) {
    try {
        # Create destination directory if it doesn't exist
        if (!(Test-Path $customEvaluatorsDest)) {
            New-Item -ItemType Directory -Path $customEvaluatorsDest -Force | Out-Null
        }
        
        # Copy all files from CustomEvaluators folder
        Copy-Item -Path "$customEvaluatorsSource\*" -Destination $customEvaluatorsDest -Recurse -Force
        
        $copiedFiles = Get-ChildItem -Path $customEvaluatorsDest
        Write-Host "✅ Copied $($copiedFiles.Count) custom evaluator file(s) to bin directory" -ForegroundColor Green
        
        if ($VerboseOutput) {
            foreach ($file in $copiedFiles) {
                Write-Host "   • $($file.Name)" -ForegroundColor Gray
            }
        }
    } catch {
        Write-Host "⚠️  Warning: Failed to copy custom evaluators: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "   LocalEvalRunner may not find custom evaluator configurations..." -ForegroundColor Gray
    }
} else {
    Write-Host "⚠️  CustomEvaluators folder not found at: $customEvaluatorsSource" -ForegroundColor Yellow
}

# Initialize evaluation project if needed (first-time setup)
Write-Host ""
Write-Host "🎯 Checking project initialization..." -ForegroundColor Cyan

# Check if key configuration exists (we use common scenarios now, so don't check for local scenarios)
$needsInit = $false
if (!(Test-Path $ConfigPath)) {
    $needsInit = $true
    Write-Host "   📦 Configuration setup detected, creating appsettings..." -ForegroundColor Yellow
    
    try {
        # Create basic appsettings.json if it doesn't exist (skip init to avoid hanging)
        if (!(Test-Path $ConfigPath)) {
            $basicConfig = @{
                "AzureOpenAI" = @{
                    "Endpoint" = "https://hwfoundry.openai.azure.com/"
                    "ModelDeploymentName" = "gpt-4.1"
                }
                "LocalEvalRunner" = @{
                    "MaxConcurrency" = 3
                }
            } | ConvertTo-Json -Depth 3
            
            $basicConfig | Out-File -FilePath $ConfigPath -Encoding UTF8
            Write-Host "   ✅ Basic configuration created!" -ForegroundColor Green
        } else {
            Write-Host "   ✅ Configuration already exists!" -ForegroundColor Green
        }
        
        Write-Host ""
        Write-Host "   Configuration setup:" -ForegroundColor Gray
        Write-Host "     • appsettings.json (basic configuration)" -ForegroundColor White
        Write-Host "     • Using common scenarios from ../scenarios/" -ForegroundColor White
    } catch {
        Write-Host "   ⚠️  Configuration setup warning: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "   Continuing with existing configuration..." -ForegroundColor Gray
    }
} else {
    Write-Host "   ✅ Project already initialized" -ForegroundColor Green
}

Write-Host ""

# Validate inputs
try {
    $null = Get-Command $BinPath -ErrorAction Stop
} catch {
    Write-Host "❌ LocalEvalRunner not found in PATH" -ForegroundColor Red
    Write-Host "💡 Run .\setup.ps1 first to install the tool" -ForegroundColor Yellow
    exit 1
}

if (!(Test-Path $ConfigPath)) {
    Write-Host "❌ Configuration file not found at: $ConfigPath" -ForegroundColor Red
    Write-Host "💡 Check that the config file exists or specify a different path with -Config" -ForegroundColor Yellow
    exit 1
}

if (!(Test-Path $TestPath)) {
    Write-Host "❌ Test file not found at: $TestPath" -ForegroundColor Red
    Write-Host "💡 Check the test file path or create test files in the scenarios directory" -ForegroundColor Yellow
    exit 1
}

# Create output directory if it doesn't exist
if (!(Test-Path $ReportsPath)) {
    New-Item -ItemType Directory -Path $ReportsPath -Force | Out-Null
    Write-Host "📁 Created reports directory: $ReportsPath" -ForegroundColor Yellow
}

# Generate bin appsettings.json with parent values
Write-Host "⚙️  Generating LocalEvalRunner configuration..." -ForegroundColor Cyan

$BinConfigPath = Join-Path $ScriptDir "bin\appsettings.json"
$ParentConfigPath = Join-Path (Split-Path (Split-Path $ScriptDir -Parent) -Parent) "appsettings.json"

try {
    # Read the template config from configs directory
    $templateConfig = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    
    # Read parent config for Azure OpenAI settings
    if (Test-Path $ParentConfigPath) {
        $parentConfig = Get-Content -Path $ParentConfigPath -Raw | ConvertFrom-Json
        $azureEndpoint = $parentConfig.AzureOpenAIEndpoint
        $modelDeployment = $parentConfig.ModelDeployment
        
        # Update template with parent values
        $templateConfig.AiSettings.Endpoint = $azureEndpoint
        $templateConfig.AiSettings.ModelName = $modelDeployment
        
        Write-Host "   🔗 Using Azure OpenAI Endpoint: $azureEndpoint" -ForegroundColor Gray
        Write-Host "   🤖 Using Model Deployment: $modelDeployment" -ForegroundColor Gray
    } else {
        Write-Host "   ⚠️  Parent config not found, using template values" -ForegroundColor Yellow
    }
    
    # Write the configuration to bin directory
    $templateConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $BinConfigPath -Encoding UTF8
    Write-Host "✅ Configuration generated: $BinConfigPath" -ForegroundColor Green
    
    # Update Config path to use the bin version
    $ConfigPath = $BinConfigPath
    
} catch {
    Write-Host "❌ Failed to generate bin configuration: $($_.Exception.Message)" -ForegroundColor Red
    throw
}

# Display execution parameters
Write-Host ""
Write-Host "📋 Execution Parameters:" -ForegroundColor Cyan
Write-Host "   Test File: $TestFile" -ForegroundColor Gray
Write-Host "   Config: $Config" -ForegroundColor Gray
Write-Host "   Concurrency: $Concurrency" -ForegroundColor Gray
Write-Host "   Output Directory: $OutputDir" -ForegroundColor Gray
Write-Host "   LocalEvalRunner: $BinPath" -ForegroundColor Gray
Write-Host ""

# Check Azure authentication
Write-Host "🔐 Checking Azure authentication..." -ForegroundColor Cyan
try {
    $azContext = az account show 2>$null | ConvertFrom-Json
    if ($azContext) {
        Write-Host "✅ Azure CLI authenticated as: $($azContext.user.name)" -ForegroundColor Green
        Write-Host "📝 Subscription: $($azContext.name)" -ForegroundColor Gray
    } else {
        Write-Host "⚠️  Azure CLI not authenticated. Run 'az login' if using Azure OpenAI with DefaultAzureCredential" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  Could not check Azure CLI status. Ensure Azure CLI is installed if using DefaultAzureCredential" -ForegroundColor Yellow
}

Write-Host ""

# Build LocalEvalRunner command arguments
$arguments = @(
    "`"$TestPath`"",
    "--config", "`"$ConfigPath`"",
    "--output", "`"$ReportsPath`"",
    "--concurrency", $Concurrency
)

if ($VerboseOutput) {
    Write-Host "🔧 Command: $BinPath $($arguments -join ' ')" -ForegroundColor Gray
    Write-Host ""
}

# Run LocalEvalRunner
Write-Host "🚀 Starting Agent365 evaluation..." -ForegroundColor Green
Write-Host ""

$startTime = Get-Date

try {
    # Execute LocalEvalRunner from bin directory so it finds LocalAgentConfig relative to working directory
    $binDirectory = Join-Path $ScriptDir "bin"
    Push-Location $binDirectory
    $process = Start-Process -FilePath $BinPath -ArgumentList $arguments -NoNewWindow -Wait -PassThru
    
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    # Restore original working directory
    Pop-Location
    
    Write-Host ""
    
    if ($process.ExitCode -eq 0) {
        Write-Host "✅ Evaluation completed successfully!" -ForegroundColor Green
        Write-Host "⏱️  Total time: $($duration.ToString('mm\:ss'))" -ForegroundColor Gray
        
        # Find generated reports
        $reports = Get-ChildItem -Path $ReportsPath -Filter "evaluation_report_*" | Sort-Object LastWriteTime -Descending
        
        if ($reports) {
            Write-Host ""
            Write-Host "📊 Generated Reports:" -ForegroundColor Cyan
            foreach ($report in $reports | Select-Object -First 3) {
                Write-Host "   $($report.Name)" -ForegroundColor Gray
            }
        }
        
        # Generate results viewer
        Write-Host ""
        Write-Host "🌐 Generating results viewer..." -ForegroundColor Cyan
        $resultsViewerScript = Join-Path (Split-Path $ScriptDir -Parent) "ResultsViewer\Generate-ResultsViewer.ps1"
        
        if (Test-Path $resultsViewerScript) {
            try {
                # Always generate and open the results viewer
                & $resultsViewerScript -Force -Open
                Write-Host "✅ Results viewer generated and opened successfully" -ForegroundColor Green
            } catch {
                Write-Host "⚠️  Warning: Failed to generate results viewer: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        } else {
            Write-Host "⚠️  Results viewer generator not found at: $resultsViewerScript" -ForegroundColor Yellow
        }
        

        
        Write-Host ""
        Write-Host "🎉 Agent365 evaluation complete!" -ForegroundColor Green
        Write-Host "📁 Reports saved to: $ReportsPath" -ForegroundColor Gray
        if (Test-Path (Join-Path (Split-Path $ScriptDir -Parent) "ResultsViewer\index.html")) {
            Write-Host "🌐 Results viewer: ../ResultsViewer/index.html" -ForegroundColor Gray
        }
        
    } else {
        Write-Host "❌ Evaluation failed with exit code: $($process.ExitCode)" -ForegroundColor Red
        exit $process.ExitCode
    }
    
} catch {
    # Restore original working directory on error
    Pop-Location
    Write-Host "❌ Error running evaluation: $($_.Exception.Message)" -ForegroundColor Red
    throw
}

Write-Host ""
Write-Host "💡 Tips:" -ForegroundColor Yellow
Write-Host "   • Review generated reports for detailed analysis" -ForegroundColor Gray
Write-Host "   • Adjust evaluation criteria in $Config" -ForegroundColor Gray
Write-Host "   • Create additional test files in the ../scenarios directory" -ForegroundColor Gray
Write-Host "   • Results viewer opens automatically after completion" -ForegroundColor Gray