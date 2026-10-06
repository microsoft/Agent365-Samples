# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Automatically creates GitHub issues for E2E test failures.

.DESCRIPTION
    This script creates GitHub issues when E2E tests fail, categorizing errors
    and linking them to the metrics dashboard for tracking.

.PARAMETER MetricsFile
    Path to the metrics JSON file from Emit-TestMetrics.ps1

.PARAMETER Repository
    GitHub repository in format "owner/repo"

.PARAMETER Labels
    Additional labels to add to the issue

.PARAMETER DryRun
    If set, only outputs what would be created without actually creating issues

.EXAMPLE
    ./Create-GitHubIssue.ps1 -MetricsFile "./metrics.json" -Repository "microsoft/Agent365-Samples"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$MetricsFile,

    [Parameter(Mandatory = $false)]
    [string]$Repository = $(if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { "microsoft/Agent365-Samples" }),

    [Parameter(Mandatory = $false)]
    [string[]]$Labels = @("e2e-failure", "automated"),

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Error category patterns for classification
$ErrorCategories = @{
    "SDK:Authentication" = @(
        "authentication",
        "auth failed",
        "unauthorized",
        "401",
        "credential",
        "token",
        "DefaultAzureCredential"
    )
    "SDK:Connection" = @(
        "connection",
        "timeout",
        "network",
        "socket",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "connection refused"
    )
    "SDK:Configuration" = @(
        "configuration",
        "config",
        "missing.*key",
        "environment variable",
        "appsettings",
        "not configured"
    )
    "SDK:BreakingChange" = @(
        "breaking change",
        "deprecated",
        "removed",
        "no longer",
        "api changed",
        "schema.*changed"
    )
    "SDK:TypeMismatch" = @(
        "type.*error",
        "cannot convert",
        "invalid cast",
        "type mismatch",
        "expected.*got"
    )
    "SDK:MissingDependency" = @(
        "module not found",
        "package not found",
        "import error",
        "could not load",
        "dependency"
    )
    "Test:Assertion" = @(
        "assert",
        "expected",
        "should be",
        "to equal",
        "not equal"
    )
    "Test:Timeout" = @(
        "test.*timeout",
        "exceeded.*time",
        "took too long"
    )
    "Infrastructure:Service" = @(
        "service unavailable",
        "503",
        "502",
        "bad gateway",
        "server error"
    )
    "Other" = @()
}

function Get-ErrorCategory {
    param([string]$ErrorMessage)
    
    $lowerMessage = $ErrorMessage.ToLower()
    
    foreach ($category in $ErrorCategories.Keys) {
        if ($category -eq "Other") { continue }
        
        foreach ($pattern in $ErrorCategories[$category]) {
            if ($lowerMessage -match $pattern) {
                return $category
            }
        }
    }
    
    return "Other"
}

function Get-IssuePriority {
    param(
        [string]$Stage,
        [string]$Category
    )
    
    # Higher priority for issues caught later in the pipeline
    $stagePriority = switch ($Stage) {
        "release" { "P0" }
        "post-checkin" { "P1" }
        "pre-checkin" { "P2" }
        "pre-release" { "P2" }
        default { "P3" }
    }
    
    # SDK breaking changes are high priority
    if ($Category -eq "SDK:BreakingChange") {
        $stagePriority = "P1"
    }
    
    return $stagePriority
}

function New-GitHubIssue {
    param(
        [hashtable]$IssueData,
        [string]$Repository,
        [switch]$DryRun
    )
    
    $title = $IssueData.title
    $body = $IssueData.body
    $labels = $IssueData.labels -join ","
    
    if ($DryRun) {
        Write-Host ""
        Write-Host "=== DRY RUN: Would create issue ===" -ForegroundColor Yellow
        Write-Host "Title: $title" -ForegroundColor Cyan
        Write-Host "Labels: $labels" -ForegroundColor Gray
        Write-Host "Body:" -ForegroundColor Gray
        Write-Host $body
        Write-Host "===================================" -ForegroundColor Yellow
        return @{ number = 0; html_url = "https://github.com/$Repository/issues/NEW" }
    }
    
    # Use GitHub CLI to create issue
    $bodyFile = [System.IO.Path]::GetTempFileName()
    $body | Out-File -FilePath $bodyFile -Encoding UTF8
    
    try {
        $result = gh issue create `
            --repo $Repository `
            --title $title `
            --body-file $bodyFile `
            --label ($IssueData.labels -join ",") 2>&1
        
        # Check for gh CLI errors
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Error: gh issue create failed with exit code $LASTEXITCODE" -ForegroundColor Red
            Write-Host "Output: $result" -ForegroundColor Yellow
            return $null
        }
        
        # Parse issue URL from result
        if ($result -match "https://github.com/.+/issues/(\d+)") {
            $issueNumber = $Matches[1]
            return @{
                number = [int]$issueNumber
                html_url = $result.Trim()
            }
        }
        
        Write-Host "Error: Failed to create issue. Could not parse URL from output: $result" -ForegroundColor Red
        return $null
    }
    catch {
        Write-Host "Error creating issue: $_" -ForegroundColor Red
        return $null
    }
    finally {
        try {
            Remove-Item $bodyFile -Force -ErrorAction Stop
        }
        catch {
            Write-Host "Warning: Could not clean up temp file $bodyFile : $_" -ForegroundColor Yellow
        }
    }
}

# Main logic
Write-Host "=== GitHub Issue Creator for E2E Failures ===" -ForegroundColor Cyan
Write-Host "Metrics File: $MetricsFile" -ForegroundColor Gray
Write-Host "Repository: $Repository" -ForegroundColor Gray
Write-Host ""

# Load metrics
if (!(Test-Path $MetricsFile)) {
    Write-Host "Error: Metrics file not found: $MetricsFile" -ForegroundColor Red
    exit 1
}

$metrics = Get-Content $MetricsFile | ConvertFrom-Json

# Check if there are failures
if ($metrics.testResults.failed -eq 0) {
    Write-Host "✅ No failures detected. No issues to create." -ForegroundColor Green
    exit 0
}

Write-Host "🐛 Found $($metrics.testResults.failed) failure(s)" -ForegroundColor Yellow
Write-Host ""

# Process each failure
$createdIssues = @()
$categorizedErrors = @{}

foreach ($bug in $metrics.bugsCaught.details) {
    $category = Get-ErrorCategory -ErrorMessage $bug.errorMessage
    $priority = Get-IssuePriority -Stage $metrics.stage -Category $category
    
    # Track categorized errors
    if (!$categorizedErrors[$category]) {
        $categorizedErrors[$category] = @{
            count = 0
            samples = @()
            tests = @()
        }
    }
    $categorizedErrors[$category].count++
    if ($categorizedErrors[$category].samples -notcontains $metrics.sampleName) {
        $categorizedErrors[$category].samples += $metrics.sampleName
    }
    $categorizedErrors[$category].tests += $bug.testName
    
    # Build SDK version info
    $sdkInfo = if ($metrics.sdkVersions) {
        ($metrics.sdkVersions.PSObject.Properties | ForEach-Object { "- $($_.Name): ``$($_.Value)``" }) -join "`n"
    } else { "Not available" }
    
    # Create issue body
    $body = @"
## E2E Test Failure Report

**Category:** $category
**Priority:** $priority
**Stage:** $($metrics.stage)
**Sample:** $($metrics.sampleName)
**Test:** $($bug.testName)

### Error Message
``````
$($bug.errorMessage)
``````

### SDK Versions
$sdkInfo

### Context
- **Run ID:** $($metrics.runId)
- **Commit:** $($metrics.commitSha)
- **Branch:** $($metrics.branch)
- **Timestamp:** $($metrics.timestamp)

### Reproduction
1. Checkout commit ``$($metrics.commitSha)``
2. Navigate to the ``$($metrics.sampleName)`` sample
3. Run the E2E tests

---
*This issue was automatically created by the E2E test pipeline.*
*Dashboard: [View Metrics]($(if ($env:METRICS_DASHBOARD_URL) { $env:METRICS_DASHBOARD_URL } else { 'https://microsoft.github.io/Agent365-Samples/metrics/' }))*
"@

    $issueData = @{
        title = "[$priority][$category] $($bug.testName) failed in $($metrics.sampleName)"
        body = $body
        labels = @($Labels) + @($category.Replace(":", "-").ToLower(), $priority.ToLower(), $metrics.stage)
    }
    
    Write-Host "Creating issue for: $($bug.testName)" -ForegroundColor Cyan
    Write-Host "  Category: $category" -ForegroundColor Gray
    Write-Host "  Priority: $priority" -ForegroundColor Gray
    
    $issue = New-GitHubIssue -IssueData $issueData -Repository $Repository -DryRun:$DryRun
    
    if ($issue) {
        $createdIssues += @{
            issueNumber = $issue.number
            issueUrl = $issue.html_url
            testName = $bug.testName
            category = $category
            priority = $priority
        }
        Write-Host "  Created: $($issue.html_url)" -ForegroundColor Green
    }
}

# Output summary
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "Issues created: $($createdIssues.Count)" -ForegroundColor Gray

Write-Host ""
Write-Host "Error Categories:" -ForegroundColor Cyan
foreach ($cat in $categorizedErrors.Keys | Sort-Object) {
    $data = $categorizedErrors[$cat]
    Write-Host "  $cat : $($data.count) failure(s) across $($data.samples.Count) sample(s)" -ForegroundColor Gray
}

# Output JSON for workflow consumption
$output = @{
    timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    metricsId = $metrics.id
    issuesCreated = $createdIssues
    categorizedErrors = $categorizedErrors
}

$output | ConvertTo-Json -Depth 10
