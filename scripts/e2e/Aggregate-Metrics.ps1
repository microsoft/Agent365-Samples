# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Aggregates individual test metrics into a consolidated metrics history file.

.DESCRIPTION
    This script reads individual metric JSON files and appends them to a history file,
    enabling historical trend analysis across multiple test runs.

.PARAMETER MetricsDir
    Directory containing individual metric JSON files

.PARAMETER HistoryFile
    Path to the consolidated history JSON file

.PARAMETER MaxEntries
    Maximum number of entries to keep in history (0 = unlimited)

.EXAMPLE
    ./Aggregate-Metrics.ps1 -MetricsDir "./metrics/raw" -HistoryFile "./docs/metrics/history.json"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$MetricsDir,

    [Parameter(Mandatory = $true)]
    [string]$HistoryFile,

    [Parameter(Mandatory = $false)]
    [int]$MaxEntries = 0
)

$ErrorActionPreference = "Stop"

Write-Host "=== Aggregating Metrics ===" -ForegroundColor Cyan
Write-Host "Source: $MetricsDir" -ForegroundColor Gray
Write-Host "Target: $HistoryFile" -ForegroundColor Gray

# Load existing history
$history = @{
    lastUpdated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    totalRuns = 0
    entries = @()
    summary = @{
        byStage = @{
            "pre-release" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
            "pre-checkin" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
            "post-checkin" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
            "release" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
            "scheduled" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
        }
        bySample = @{}
        totalBugsCaught = 0
        totalTestsRun = 0
        totalPassed = 0
        totalFailed = 0
    }
}

if (Test-Path $HistoryFile) {
    try {
        $existingHistory = Get-Content $HistoryFile -Raw | ConvertFrom-Json -AsHashtable
        # Validate parsed JSON has expected properties before accessing
        if ($existingHistory -and $existingHistory.entries) {
            $history.entries = $existingHistory.entries
        }
        if ($existingHistory -and $existingHistory.summary) {
            $history.summary = $existingHistory.summary
        }
        Write-Host "Loaded existing history with $($history.entries.Count) entries" -ForegroundColor Green
    }
    catch {
        Write-Host "Warning: Could not load existing history, starting fresh: $_" -ForegroundColor Yellow
    }
}

# Get existing entry IDs to avoid duplicates
$existingIds = @{}
foreach ($entry in $history.entries) {
    if ($entry.id) {
        $existingIds[$entry.id] = $true
    }
}

# Read new metrics files
$newEntries = @()
if (Test-Path $MetricsDir) {
    $metricFiles = Get-ChildItem -Path $MetricsDir -Filter "*.json" -File
    
    foreach ($file in $metricFiles) {
        try {
            $metrics = Get-Content $file.FullName -Raw | ConvertFrom-Json -AsHashtable
            
            # Skip if already in history
            if ($existingIds.ContainsKey($metrics.id)) {
                Write-Host "Skipping duplicate: $($metrics.id)" -ForegroundColor Gray
                continue
            }
            
            $newEntries += $metrics
            Write-Host "Adding: $($metrics.sampleName) - $($metrics.stage) - $($metrics.testResults.status)" -ForegroundColor Green
        }
        catch {
            Write-Host "Warning: Could not parse $($file.Name): $_" -ForegroundColor Yellow
        }
    }
}

Write-Host "Found $($newEntries.Count) new entries to add" -ForegroundColor Cyan

# Add new entries
$history.entries += $newEntries

# Sort by timestamp (newest first)
$history.entries = $history.entries | Sort-Object { $_.timestamp } -Descending

# Apply max entries limit if specified
if ($MaxEntries -gt 0 -and $history.entries.Count -gt $MaxEntries) {
    $history.entries = $history.entries | Select-Object -First $MaxEntries
    Write-Host "Trimmed to $MaxEntries entries" -ForegroundColor Yellow
}

# Recalculate summary statistics
$history.summary = @{
    byStage = @{
        "pre-release" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
        "pre-checkin" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
        "post-checkin" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
        "release" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
        "scheduled" = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
    }
    bySample = @{}
    totalBugsCaught = 0
    totalTestsRun = 0
    totalPassed = 0
    totalFailed = 0
}

foreach ($entry in $history.entries) {
    $stage = $entry.stage
    $sample = $entry.sampleName
    $results = $entry.testResults
    $bugs = $entry.bugsCaught
    
    # Update stage stats
    if ($history.summary.byStage.ContainsKey($stage)) {
        $history.summary.byStage[$stage].runs++
        $history.summary.byStage[$stage].passed += $results.passed
        $history.summary.byStage[$stage].failed += $results.failed
        $history.summary.byStage[$stage].bugsCaught += $bugs.count
    }
    
    # Update sample stats
    if (-not $history.summary.bySample.ContainsKey($sample)) {
        $history.summary.bySample[$sample] = @{ runs = 0; passed = 0; failed = 0; bugsCaught = 0 }
    }
    $history.summary.bySample[$sample].runs++
    $history.summary.bySample[$sample].passed += $results.passed
    $history.summary.bySample[$sample].failed += $results.failed
    $history.summary.bySample[$sample].bugsCaught += $bugs.count
    
    # Update totals
    $history.summary.totalBugsCaught += $bugs.count
    $history.summary.totalTestsRun += $results.total
    $history.summary.totalPassed += $results.passed
    $history.summary.totalFailed += $results.failed
}

$history.totalRuns = $history.entries.Count
$history.lastUpdated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# Ensure output directory exists
$outputDir = Split-Path $HistoryFile -Parent
if ($outputDir -and !(Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Write history file
$historyJson = $history | ConvertTo-Json -Depth 10
$historyJson | Out-File -FilePath $HistoryFile -Encoding UTF8

Write-Host ""
Write-Host "✅ History updated: $HistoryFile" -ForegroundColor Green
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "Total Runs: $($history.totalRuns)" -ForegroundColor Gray
Write-Host "Total Bugs Caught: $($history.summary.totalBugsCaught)" -ForegroundColor $(if ($history.summary.totalBugsCaught -gt 0) { "Yellow" } else { "Green" })
Write-Host "Tests: $($history.summary.totalPassed) passed, $($history.summary.totalFailed) failed" -ForegroundColor Gray
Write-Host ""
Write-Host "Bugs by Stage:" -ForegroundColor Cyan
foreach ($stage in $history.summary.byStage.Keys) {
    $stageStats = $history.summary.byStage[$stage]
    Write-Host "  $stage : $($stageStats.bugsCaught) bugs in $($stageStats.runs) runs" -ForegroundColor Gray
}
