<#
.SYNOPSIS
    Emits structured test metrics for tracking E2E test results and SDK versions.

.DESCRIPTION
    This script collects test results, SDK versions, and metadata to create a JSON
    metrics file that can be used for dashboards and historical analysis.
    It also validates that samples are using the latest SDK versions (including pre-release).

.PARAMETER SampleName
    Name of the sample being tested (e.g., "python-openai", "nodejs-langchain")

.PARAMETER SamplePath
    Path to the sample directory (for SDK version validation)

.PARAMETER SampleType
    Type of sample: "dotnet", "python", "nodejs" (for SDK version validation)

.PARAMETER TestResultsPath
    Path to the test results TRX file

.PARAMETER SdkVersions
    Hashtable of SDK versions (e.g., @{ "microsoft-agents-a365" = "0.1.5" })

.PARAMETER Stage
    The testing stage: "pre-release", "pre-checkin", "post-checkin", "release", "scheduled"

.PARAMETER OutputPath
    Path where the metrics JSON file will be written

.PARAMETER SkipSdkValidation
    Skip SDK version validation against latest available

.EXAMPLE
    ./Emit-TestMetrics.ps1 -SampleName "python-openai" -SamplePath "./python/openai/sample-agent" -SampleType "python" -Stage "pre-checkin"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$SampleName,

    [Parameter(Mandatory = $false)]
    [string]$SamplePath,

    [Parameter(Mandatory = $false)]
    [ValidateSet("dotnet", "python", "nodejs")]
    [string]$SampleType,

    [Parameter(Mandatory = $false)]
    [string]$TestResultsPath,

    [Parameter(Mandatory = $false)]
    [hashtable]$SdkVersions = @{},

    [Parameter(Mandatory = $true)]
    [ValidateSet("pre-release", "pre-checkin", "post-checkin", "release", "scheduled")]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [int]$PassedTests = 0,

    [Parameter(Mandatory = $false)]
    [int]$FailedTests = 0,

    [Parameter(Mandatory = $false)]
    [int]$SkippedTests = 0,

    [Parameter(Mandatory = $false)]
    [string]$RunId = "",

    [Parameter(Mandatory = $false)]
    [string]$CommitSha = "",

    [Parameter(Mandatory = $false)]
    [string]$Branch = "",

    [Parameter(Mandatory = $false)]
    [switch]$SkipSdkValidation
)

$ErrorActionPreference = "Stop"

Write-Host "=== Emitting Test Metrics ===" -ForegroundColor Cyan
Write-Host "Sample: $SampleName" -ForegroundColor Gray
Write-Host "Stage: $Stage" -ForegroundColor Gray

# Parse TRX file if provided
if ($TestResultsPath -and (Test-Path $TestResultsPath)) {
    Write-Host "Parsing TRX file: $TestResultsPath" -ForegroundColor Gray
    
    try {
        [xml]$trx = Get-Content $TestResultsPath
        $counters = $trx.TestRun.ResultSummary.Counters
        
        $PassedTests = [int]$counters.passed
        $FailedTests = [int]$counters.failed
        $SkippedTests = [int]$counters.notExecuted
        
        Write-Host "Parsed: Passed=$PassedTests, Failed=$FailedTests, Skipped=$SkippedTests" -ForegroundColor Green
    }
    catch {
        Write-Host "Warning: Could not parse TRX file: $_" -ForegroundColor Yellow
    }
}

# Get environment info
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$runId = if ($RunId) { $RunId } elseif ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { "local-$(Get-Date -Format 'yyyyMMddHHmmss')" }
$commitSha = if ($CommitSha) { $CommitSha } elseif ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { (git rev-parse HEAD 2>$null) -or "unknown" }
$branch = if ($Branch) { $Branch } elseif ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } else { (git branch --show-current 2>$null) -or "unknown" }
$actor = if ($env:GITHUB_ACTOR) { $env:GITHUB_ACTOR } else { $env:USERNAME }
$workflow = if ($env:GITHUB_WORKFLOW) { $env:GITHUB_WORKFLOW } else { "local" }

# Calculate test status
$totalTests = $PassedTests + $FailedTests + $SkippedTests
$status = if ($FailedTests -gt 0) { "failed" } elseif ($totalTests -eq 0) { "no-tests" } else { "passed" }

# Run SDK version validation if sample path and type are provided
$sdkValidation = $null
if (-not $SkipSdkValidation -and $SamplePath -and $SampleType) {
    Write-Host ""
    Write-Host "🔍 Validating SDK versions..." -ForegroundColor Cyan
    
    $validateScript = Join-Path $PSScriptRoot "Validate-SdkVersions.ps1"
    if (Test-Path $validateScript) {
        try {
            $validationJson = & $validateScript -SamplePath $SamplePath -SampleType $SampleType -IncludePreRelease $true -OutputJson 2>&1 | Select-Object -Last 1
            if ($validationJson) {
                $sdkValidation = $validationJson | ConvertFrom-Json
                
                # Extract installed versions if not already provided
                if ($SdkVersions.Count -eq 0 -and $sdkValidation.packages) {
                    foreach ($pkg in $sdkValidation.packages) {
                        $SdkVersions[$pkg.package] = $pkg.installed
                    }
                }
                
                Write-Host "SDK Validation: $($sdkValidation.validation.upToDate)/$($sdkValidation.validation.packagesChecked) packages up to date" -ForegroundColor $(if ($sdkValidation.validation.allUpToDate) { "Green" } else { "Yellow" })
            }
        }
        catch {
            Write-Host "Warning: SDK validation failed: $_" -ForegroundColor Yellow
        }
    }
}

# Build metrics object
$metrics = @{
    # Identifiers
    id = "$runId-$SampleName"
    runId = $runId
    sampleName = $SampleName
    
    # Timing
    timestamp = $timestamp
    
    # Git info
    commitSha = $commitSha
    branch = $branch
    actor = $actor
    
    # Workflow info
    workflow = $workflow
    stage = $Stage
    
    # Test results
    testResults = @{
        status = $status
        passed = $PassedTests
        failed = $FailedTests
        skipped = $SkippedTests
        total = $totalTests
    }
    
    # SDK versions
    sdkVersions = $SdkVersions
    
    # SDK version validation
    sdkValidation = if ($sdkValidation) {
        @{
            allUpToDate = $sdkValidation.validation.allUpToDate
            packagesChecked = $sdkValidation.validation.packagesChecked
            upToDate = $sdkValidation.validation.upToDate
            outdated = $sdkValidation.validation.outdated
            usingPreRelease = $sdkValidation.validation.usingPreRelease
            packages = $sdkValidation.packages | ForEach-Object {
                @{
                    package = $_.package
                    installed = $_.installed
                    latest = $_.latest
                    isUpToDate = $_.isUpToDate
                    isPreRelease = $_.isPreRelease
                }
            }
        }
    } else { $null }
    
    # Bugs caught (will be populated if tests failed)
    bugsCaught = @{
        count = $FailedTests
        stage = $Stage
        details = @()
    }
}

# If we have a TRX file, extract failed test details
if ($TestResultsPath -and (Test-Path $TestResultsPath) -and $FailedTests -gt 0) {
    try {
        [xml]$trx = Get-Content $TestResultsPath
        $failedResults = $trx.TestRun.Results.UnitTestResult | Where-Object { $_.outcome -eq "Failed" }
        
        foreach ($result in $failedResults) {
            $metrics.bugsCaught.details += @{
                testName = $result.testName
                errorMessage = ($result.Output.ErrorInfo.Message -replace "`r`n", " " -replace "`n", " ").Substring(0, [Math]::Min(500, $result.Output.ErrorInfo.Message.Length))
            }
        }
    }
    catch {
        Write-Host "Warning: Could not extract failed test details: $_" -ForegroundColor Yellow
    }
}

# Ensure output directory exists
$outputDir = Split-Path $OutputPath -Parent
if ($outputDir -and !(Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Write metrics file
$metricsJson = $metrics | ConvertTo-Json -Depth 10
$metricsJson | Out-File -FilePath $OutputPath -Encoding UTF8

Write-Host ""
Write-Host "✅ Metrics written to: $OutputPath" -ForegroundColor Green
Write-Host ""
Write-Host "=== Metrics Summary ===" -ForegroundColor Cyan
Write-Host "Status: $status" -ForegroundColor $(if ($status -eq "passed") { "Green" } else { "Red" })
Write-Host "Tests: $PassedTests passed, $FailedTests failed, $SkippedTests skipped" -ForegroundColor Gray
Write-Host "Stage: $Stage" -ForegroundColor Gray
Write-Host "SDK Versions: $($SdkVersions.Count) tracked" -ForegroundColor Gray

# Output the metrics for workflow consumption
Write-Output $metricsJson
