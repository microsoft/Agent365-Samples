#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Generates a web-based results viewer for Agent365 LocalEvalTool evaluation reports

.DESCRIPTION
    This script creates a self-contained HTML results viewer that embeds all evaluation 
    report data from the reports directory. The generated viewer can be opened in any 
    web browser without requiring a web server.

.PARAMETER ReportsDir
    The directory containing evaluation report JSON files (default: ../reports)

.PARAMETER OutputFile
    The output HTML file path (default: index.html)

.PARAMETER Force
    Force regeneration even if the output file already exists

.PARAMETER Open
    Automatically open the generated results viewer in the default browser

.EXAMPLE
    .\Generate-ResultsViewer.ps1
    Generate results viewer with default settings

.EXAMPLE
    .\Generate-ResultsViewer.ps1 -Force -Open
    Force regenerate and open the results viewer

.EXAMPLE
    .\Generate-ResultsViewer.ps1 -ReportsDir "custom\path" -OutputFile "custom-results.html"
    Generate with custom paths
#>

param(
    [string]$ReportsDir = "..\reports",
    [string]$OutputFile = "index.html",
    [switch]$Force,
    [switch]$Open
)

$ErrorActionPreference = "Stop"

# Get script paths
$ScriptDir = $PSScriptRoot
$ReportsPath = Join-Path $ScriptDir $ReportsDir
$OutputPath = Join-Path $ScriptDir $OutputFile
$TemplatePath = Join-Path $ScriptDir "template.html"
$ScriptTemplatePath = Join-Path $ScriptDir "script.js"
$StylesPath = Join-Path $ScriptDir "styles.css"

Write-Host "🌐 Agent365 Results Viewer Generator" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green
Write-Host ""

# Check if output file exists and Force is not specified
if ((Test-Path $OutputPath) -and !$Force) {
    Write-Host "⚠️  Results viewer already exists: $OutputPath" -ForegroundColor Yellow
    Write-Host "   Use -Force to regenerate or -Open to view existing file" -ForegroundColor Gray
    
    if ($Open) {
        Write-Host "🚀 Opening existing results viewer..." -ForegroundColor Cyan
        Start-Process $OutputPath
    }
    return
}

Write-Host "📍 Reports Directory: $ReportsPath" -ForegroundColor Gray
Write-Host "📍 Output File: $OutputPath" -ForegroundColor Gray
Write-Host ""

# Validate template files exist
if (!(Test-Path $TemplatePath)) {
    Write-Host "❌ Template file not found: $TemplatePath" -ForegroundColor Red
    exit 1
}

if (!(Test-Path $ScriptTemplatePath)) {
    Write-Host "❌ Script template not found: $ScriptTemplatePath" -ForegroundColor Red
    exit 1
}

if (!(Test-Path $StylesPath)) {
    Write-Host "❌ Styles file not found: $StylesPath" -ForegroundColor Red
    exit 1
}

# Function: Get evaluation report files
function Get-EvaluationFiles {
    if (!(Test-Path $ReportsPath)) {
        Write-Host "⚠️  Reports directory not found: $ReportsPath" -ForegroundColor Yellow
        return @()
    }
    
    $files = Get-ChildItem -Path $ReportsPath -Filter "*.json" | 
             Where-Object { $_.Name -match "evaluation_report_" } |
             Sort-Object LastWriteTime -Descending
    
    return $files | ForEach-Object { $_.Name }
}

# Function: Read evaluation report data
function Read-EvaluationData {
    param([string[]]$FileNames)
    
    $evaluationData = @{}
    
    foreach ($fileName in $FileNames) {
        try {
            $filePath = Join-Path $ReportsPath $fileName
            $content = Get-Content -Path $filePath -Raw -Encoding UTF8
            $data = $content | ConvertFrom-Json
            $evaluationData[$fileName] = $data
            Write-Host "✅ Loaded: $fileName" -ForegroundColor Green
        }
        catch {
            Write-Host "⚠️  Failed to load: $fileName - $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    
    return $evaluationData
}

# Main execution
Write-Host "🔍 Scanning for evaluation reports..." -ForegroundColor Cyan
$reportFiles = Get-EvaluationFiles

if ($reportFiles.Count -eq 0) {
    Write-Host "❌ No evaluation reports found in: $ReportsPath" -ForegroundColor Red
    Write-Host "💡 Run evaluations first to generate reports" -ForegroundColor Yellow
    exit 1
}

Write-Host "📊 Found $($reportFiles.Count) evaluation report(s)" -ForegroundColor Green
Write-Host ""

Write-Host "📖 Loading evaluation data..." -ForegroundColor Cyan
$evaluationData = Read-EvaluationData -FileNames $reportFiles

if ($evaluationData.Count -eq 0) {
    Write-Host "❌ No valid evaluation data could be loaded" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🔨 Generating self-contained results viewer..." -ForegroundColor Cyan

try {
    # Read template files
    $htmlTemplate = Get-Content -Path $TemplatePath -Raw -Encoding UTF8
    $scriptTemplate = Get-Content -Path $ScriptTemplatePath -Raw -Encoding UTF8
    $stylesContent = Get-Content -Path $StylesPath -Raw -Encoding UTF8
    
    # Create embedded data object
    # Ensure files is always an array, even with single item
    $filesArray = @($reportFiles)
    $embeddedData = @{
        generated = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        files = $filesArray
        evaluationData = $evaluationData
    }
    
    # Convert to JSON with proper escaping
    $embeddedDataJson = $embeddedData | ConvertTo-Json -Depth 20 -Compress
    
    # Replace the placeholder in the script template
    $scriptWithData = $scriptTemplate -replace '/\*FILE_LIST_DATA_PLACEHOLDER\*/', "const EMBEDDED_DATA = $embeddedDataJson;"
    
    # Replace external references with embedded content in HTML template
    $finalHtml = $htmlTemplate
    $finalHtml = $finalHtml -replace '<link rel="stylesheet" href="styles.css">', "<style>`n$stylesContent`n</style>"
    $finalHtml = $finalHtml -replace '<script src="script.js"></script>', "<script>`n$scriptWithData`n</script>"
    
    # Write the final HTML file
    $finalHtml | Set-Content -Path $OutputPath -Encoding UTF8
    
    Write-Host "✅ Generated results viewer successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 Summary:" -ForegroundColor Yellow
    Write-Host "   • Reports embedded: $($reportFiles.Count)" -ForegroundColor White
    Write-Host "   • Total tests: $(($evaluationData.Values | ForEach-Object { $_.summary.totalTests } | Measure-Object -Sum).Sum)" -ForegroundColor White
    Write-Host "   • Output file: $OutputPath" -ForegroundColor White
    Write-Host "   • File size: $([math]::round((Get-Item $OutputPath).Length / 1KB, 1)) KB" -ForegroundColor White
    Write-Host ""
    
    if ($Open) {
        Write-Host "🚀 Opening results viewer..." -ForegroundColor Cyan
        Start-Process $OutputPath
    } else {
        Write-Host "💡 Open the results viewer with: Start-Process '$OutputPath'" -ForegroundColor Gray
    }
}
catch {
    Write-Host "❌ Error generating results viewer: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   Stack trace: $($_.ScriptStackTrace)" -ForegroundColor Gray
    exit 1
}