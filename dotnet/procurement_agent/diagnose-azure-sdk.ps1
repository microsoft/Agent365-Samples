#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Diagnoses Azure SDK compatibility issues in deployed web app

.DESCRIPTION
    Helps identify and fix assembly binding and compatibility issues with Azure SDK packages

.PARAMETER ResourceGroup
    Resource group containing the web app

.PARAMETER WebAppName
    Name of the web app

.EXAMPLE
    .\diagnose-azure-sdk.ps1
#>

param(
    [string]$ResourceGroup = "helloworld-rg",
    [string]$WebAppName = "zava-procurement-webapp"
)

$ErrorActionPreference = "Stop"

Write-Host "`n?? Azure SDK Diagnostics" -ForegroundColor Cyan
Write-Host "======================`n" -ForegroundColor Cyan

# 1. Check published DLLs
Write-Host "?? Checking Published Assemblies..." -ForegroundColor Yellow

if (Test-Path "publish") {
    $azureTablesDll = Get-ChildItem -Path "publish" -Recurse -Filter "Azure.Data.Tables.dll" | Select-Object -First 1
    $azureCoreDll = Get-ChildItem -Path "publish" -Recurse -Filter "Azure.Core.dll" | Select-Object -First 1
    
    if ($azureTablesDll) {
        $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($azureTablesDll.FullName).FileVersion
        Write-Host "  ? Azure.Data.Tables: $version" -ForegroundColor Green
    } else {
        Write-Host "  ? Azure.Data.Tables.dll not found in publish folder" -ForegroundColor Red
    }
    
    if ($azureCoreDll) {
        $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($azureCoreDll.FullName).FileVersion
        Write-Host "  ? Azure.Core: $version" -ForegroundColor Green
    } else {
        Write-Host "  ? Azure.Core.dll not found in publish folder" -ForegroundColor Red
    }
} else {
    Write-Host "  ??  Publish folder not found. Run deployment first." -ForegroundColor Yellow
}

# 2. Check project file
Write-Host "`n?? Checking Project Configuration..." -ForegroundColor Yellow

if (Test-Path "ProcurementA365Agent.csproj") {
    $csproj = Get-Content "ProcurementA365Agent.csproj" -Raw
    
    if ($csproj -match 'Azure\.Data\.Tables.*Version="([^"]+)"') {
        Write-Host "  ? Azure.Data.Tables version: $($Matches[1])" -ForegroundColor Green
    } else {
        Write-Host "  ? Azure.Data.Tables version not found" -ForegroundColor Red
    }
    
    if ($csproj -match 'Azure\.Core.*Version="([^"]+)"') {
        Write-Host "  ? Azure.Core version: $($Matches[1])" -ForegroundColor Green
    } else {
        Write-Host "  ??  Azure.Core version not explicitly set" -ForegroundColor Yellow
    }
    
    if ($csproj -match '<PublishSingleFile>true</PublishSingleFile>') {
        Write-Host "  ??  PublishSingleFile is enabled - this can cause assembly loading issues" -ForegroundColor Yellow
        Write-Host "     Recommendation: Set to false for Azure deployment" -ForegroundColor Gray
    }
    
    if ($csproj -match '<PublishTrimmed>true</PublishTrimmed>') {
        Write-Host "  ??  PublishTrimmed is enabled - this can cause runtime errors" -ForegroundColor Yellow
        Write-Host "     Recommendation: Set to false for Azure deployment" -ForegroundColor Gray
    }
}

# 3. Get Azure Web App logs
Write-Host "`n?? Fetching Recent Errors from Azure..." -ForegroundColor Yellow

try {
    Write-Host "  Retrieving last 50 log entries..." -ForegroundColor Gray
    
    $logs = az webapp log download `
        --name $WebAppName `
        --resource-group $ResourceGroup `
        --log-file "webapp-logs.zip" 2>&1
    
    if (Test-Path "webapp-logs.zip") {
        Write-Host "  ? Logs downloaded to webapp-logs.zip" -ForegroundColor Green
        Write-Host "     Extract and check for TypeLoadException errors" -ForegroundColor Gray
    }
} catch {
    Write-Host "  ??  Could not download logs: $_" -ForegroundColor Yellow
}

# 4. Check for known issues
Write-Host "`n?? Known Issues Check..." -ForegroundColor Yellow

$knownIssues = @(
    @{
        Name = "Azure.Data.Tables AsPages() issue"
        Description = "Method 'AsPages' not found in FuncAsyncPageable"
        Solution = "Ensure Azure.Core 1.45.0+ is explicitly referenced"
        Check = {
            param($csproj)
            if ($csproj -match 'Azure\.Core.*Version="1\.45\.0"' -or 
                $csproj -match 'Azure\.Core.*Version="1\.4[6-9]\.\d+"') {
                return $true
            }
            return $false
        }
    }
    @{
        Name = "Assembly binding redirect"
        Description = "Runtime assembly version mismatch"
        Solution = "Add runtimeconfig.template.json to project root"
        Check = {
            return Test-Path "runtimeconfig.template.json"
        }
    }
    @{
        Name = "PublishSingleFile compatibility"
        Description = "Single file publish can cause assembly loading issues"
        Solution = "Set PublishSingleFile=false in .csproj"
        Check = {
            param($csproj)
            return $csproj -notmatch '<PublishSingleFile>true</PublishSingleFile>'
        }
    }
)

foreach ($issue in $knownIssues) {
    $status = if ($csproj) { & $issue.Check -csproj $csproj } else { & $issue.Check }
    
    if ($status) {
        Write-Host "  ? $($issue.Name): OK" -ForegroundColor Green
    } else {
        Write-Host "  ? $($issue.Name): Issue detected" -ForegroundColor Red
        Write-Host "     $($issue.Description)" -ForegroundColor Gray
        Write-Host "     ?? $($issue.Solution)" -ForegroundColor Cyan
    }
}

# 5. Recommendations
Write-Host "`n?? Recommendations:" -ForegroundColor Cyan
Write-Host "==================`n" -ForegroundColor Cyan

$recommendations = @()

if (!(Test-Path "runtimeconfig.template.json")) {
    $recommendations += "Create runtimeconfig.template.json (already created by fix)"
}

if ($csproj -and ($csproj -notmatch 'Azure\.Core.*Version="1\.45\.0"')) {
    $recommendations += "Add explicit Azure.Core 1.45.0 reference (already added by fix)"
}

if ($csproj -and ($csproj -match '<PublishSingleFile>true</PublishSingleFile>')) {
    $recommendations += "Set PublishSingleFile=false in .csproj"
}

if ($csproj -and ($csproj -match '<PublishTrimmed>true</PublishTrimmed>')) {
    $recommendations += "Set PublishTrimmed=false in .csproj"
}

if ($recommendations.Count -eq 0) {
    Write-Host "  ? No additional recommendations - configuration looks good!" -ForegroundColor Green
} else {
    foreach ($rec in $recommendations) {
        Write-Host "  • $rec" -ForegroundColor Yellow
    }
}

# 6. Next steps
Write-Host "`n?? Next Steps:" -ForegroundColor Cyan
Write-Host "=============`n" -ForegroundColor Cyan

Write-Host "  1. Review the findings above" -ForegroundColor White
Write-Host "  2. Apply recommended fixes (most already applied)" -ForegroundColor White
Write-Host "  3. Rebuild and redeploy:" -ForegroundColor White
Write-Host "     .\deploy-to-webapp.ps1 -CleanPublish" -ForegroundColor Gray
Write-Host "  4. Monitor logs after deployment:" -ForegroundColor White
Write-Host "     .\deploy-utils.ps1 -Task logs" -ForegroundColor Gray
Write-Host ""

# 7. Quick fix option
$applyFix = Read-Host "Would you like to rebuild and redeploy now? (y/N)"

if ($applyFix -eq 'y' -or $applyFix -eq 'Y') {
    Write-Host "`n?? Rebuilding and deploying..." -ForegroundColor Cyan
    & .\deploy-to-webapp.ps1 -CleanPublish
} else {
    Write-Host "`n? Diagnostics complete. Review findings above." -ForegroundColor Green
}
