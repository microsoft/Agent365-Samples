# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Validates that samples are using the latest SDK versions, including pre-release.

.DESCRIPTION
    This script checks the SDK versions used in samples against the latest available
    versions from package registries (NuGet, PyPI, npm). It verifies that E2E tests
    are testing against the most recent SDK versions to catch issues early.

.PARAMETER SamplePath
    Path to the sample directory

.PARAMETER SampleType
    Type of sample: "dotnet", "python", "nodejs"

.PARAMETER IncludePreRelease
    Whether to include pre-release versions in the check (default: true)

.EXAMPLE
    ./Validate-SdkVersions.ps1 -SamplePath "./python/openai/sample-agent" -SampleType "python"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$SamplePath,

    [Parameter(Mandatory = $true)]
    [ValidateSet("dotnet", "python", "nodejs")]
    [string]$SampleType,

    [Parameter(Mandatory = $false)]
    [bool]$IncludePreRelease = $true,

    [Parameter(Mandatory = $false)]
    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"

# SDK packages to track for each platform
$SdkPackages = @{
    dotnet = @(
        "Microsoft.Agents.Hosting.AspNetCore",
        "Microsoft.Agents.Core",
        "Microsoft.Agents.CopilotStudio.Client",
        "Microsoft.SemanticKernel"
    )
    python = @(
        "microsoft-agents-core",
        "microsoft-agents-hosting-aiohttp",
        "microsoft-agents-a365-tooling-extensions-openai",
        "openai",
        "google-adk"
    )
    nodejs = @(
        "@anthropic-ai/sdk",
        "langchain",
        "@langchain/core",
        "@langchain/openai",
        "openai",
        "ai"
    )
}

function Get-NuGetLatestVersion {
    param(
        [string]$PackageName,
        [bool]$IncludePreRelease
    )
    
    try {
        $url = "https://api.nuget.org/v3-flatcontainer/$($PackageName.ToLower())/index.json"
        $response = Invoke-RestMethod -Uri $url -ErrorAction SilentlyContinue
        
        if ($response.versions) {
            $versions = $response.versions
            
            if (-not $IncludePreRelease) {
                # Filter out pre-release versions (contain -)
                $versions = $versions | Where-Object { $_ -notmatch '-' }
            }
            
            return $versions[-1]  # Last version is the latest
        }
    }
    catch {
        Write-Host "  Warning: Could not fetch NuGet version for $PackageName" -ForegroundColor Yellow
    }
    
    return $null
}

function Get-PyPILatestVersion {
    param(
        [string]$PackageName,
        [bool]$IncludePreRelease
    )
    
    try {
        $url = "https://pypi.org/pypi/$PackageName/json"
        $response = Invoke-RestMethod -Uri $url -ErrorAction SilentlyContinue
        
        if ($response.info.version) {
            $latestStable = $response.info.version
            
            if ($IncludePreRelease -and $response.releases) {
                # Get all versions and find the latest (including pre-release)
                $allVersions = $response.releases.PSObject.Properties.Name | 
                    Where-Object { $response.releases.$_.Count -gt 0 } |
                    Sort-Object { [Version]($_ -replace '[^0-9.]', '' -replace '\.+', '.').TrimEnd('.') } -ErrorAction SilentlyContinue
                
                # Get the latest pre-release if available
                $preReleases = $allVersions | Where-Object { $_ -match '(a|b|rc|dev|pre|alpha|beta)' }
                if ($preReleases) {
                    $latestPreRelease = $preReleases[-1]
                    # Compare versions to see if pre-release is newer
                    # For simplicity, return pre-release if it exists with higher base version
                    return $latestPreRelease
                }
            }
            
            return $latestStable
        }
    }
    catch {
        Write-Host "  Warning: Could not fetch PyPI version for $PackageName" -ForegroundColor Yellow
    }
    
    return $null
}

function Get-NpmLatestVersion {
    param(
        [string]$PackageName,
        [bool]$IncludePreRelease
    )
    
    try {
        $url = "https://registry.npmjs.org/$PackageName"
        $response = Invoke-RestMethod -Uri $url -ErrorAction SilentlyContinue
        
        if ($response.'dist-tags') {
            if ($IncludePreRelease) {
                # Check for next, beta, alpha, rc tags
                $preTags = @('next', 'beta', 'alpha', 'rc', 'canary', 'preview')
                foreach ($tag in $preTags) {
                    if ($response.'dist-tags'.$tag) {
                        return @{
                            version = $response.'dist-tags'.$tag
                            tag = $tag
                        }
                    }
                }
            }
            
            return @{
                version = $response.'dist-tags'.latest
                tag = 'latest'
            }
        }
    }
    catch {
        Write-Host "  Warning: Could not fetch npm version for $PackageName" -ForegroundColor Yellow
    }
    
    return $null
}

function Get-InstalledVersions {
    param(
        [string]$SamplePath,
        [string]$SampleType
    )
    
    $versions = @{}
    
    switch ($SampleType) {
        "dotnet" {
            # Parse .csproj files for PackageReference
            $csprojFiles = Get-ChildItem -Path $SamplePath -Filter "*.csproj" -Recurse
            foreach ($csproj in $csprojFiles) {
                [xml]$content = Get-Content $csproj.FullName
                $packageRefs = $content.Project.ItemGroup.PackageReference
                foreach ($pkg in $packageRefs) {
                    if ($pkg.Include -and $pkg.Version) {
                        $versions[$pkg.Include] = $pkg.Version
                    }
                }
            }
        }
        "python" {
            # Parse requirements.txt
            $reqFile = Join-Path $SamplePath "requirements.txt"
            if (Test-Path $reqFile) {
                $lines = Get-Content $reqFile
                foreach ($line in $lines) {
                    if ($line -match '^([a-zA-Z0-9_-]+)\s*([=<>!~]+)?\s*([\d.a-zA-Z-]+)?') {
                        $pkgName = $Matches[1]
                        $version = if ($Matches[3]) { $Matches[3] } else { "not-pinned" }
                        $versions[$pkgName] = $version
                    }
                }
            }
            
            # Also check pyproject.toml
            $pyprojectFile = Join-Path $SamplePath "pyproject.toml"
            if (Test-Path $pyprojectFile) {
                $content = Get-Content $pyprojectFile -Raw
                if ($content -match 'dependencies\s*=\s*\[([\s\S]*?)\]') {
                    $deps = $Matches[1]
                    $depMatches = [regex]::Matches($deps, '"([a-zA-Z0-9_-]+)\s*([=<>!~]+)?\s*([\d.a-zA-Z-]+)?"')
                    foreach ($match in $depMatches) {
                        $pkgName = $match.Groups[1].Value
                        $version = if ($match.Groups[3].Value) { $match.Groups[3].Value } else { "not-pinned" }
                        $versions[$pkgName] = $version
                    }
                }
            }
        }
        "nodejs" {
            # Parse package.json
            $pkgJsonFile = Join-Path $SamplePath "package.json"
            if (Test-Path $pkgJsonFile) {
                $pkgJson = Get-Content $pkgJsonFile | ConvertFrom-Json
                
                $allDeps = @{}
                if ($pkgJson.dependencies) {
                    $pkgJson.dependencies.PSObject.Properties | ForEach-Object {
                        $allDeps[$_.Name] = $_.Value -replace '[\^~>=<]', ''
                    }
                }
                if ($pkgJson.devDependencies) {
                    $pkgJson.devDependencies.PSObject.Properties | ForEach-Object {
                        $allDeps[$_.Name] = $_.Value -replace '[\^~>=<]', ''
                    }
                }
                
                $versions = $allDeps
            }
        }
    }
    
    return $versions
}

# Main validation logic
Write-Host "=== SDK Version Validation ===" -ForegroundColor Cyan
Write-Host "Sample Path: $SamplePath" -ForegroundColor Gray
Write-Host "Sample Type: $SampleType" -ForegroundColor Gray
Write-Host "Include Pre-Release: $IncludePreRelease" -ForegroundColor Gray
Write-Host ""

# Get installed versions
Write-Host "📦 Reading installed versions..." -ForegroundColor Cyan
$installedVersions = Get-InstalledVersions -SamplePath $SamplePath -SampleType $SampleType

if ($installedVersions.Count -eq 0) {
    Write-Host "⚠️  No package versions found in sample" -ForegroundColor Yellow
    exit 0
}

Write-Host "Found $($installedVersions.Count) packages" -ForegroundColor Gray
Write-Host ""

# Get tracked SDK packages for this type
$trackedPackages = $SdkPackages[$SampleType]

# Check each tracked package
$validationResults = @()
$hasOutdated = $false

Write-Host "🔍 Checking against latest versions..." -ForegroundColor Cyan
Write-Host ""

foreach ($pkgName in $trackedPackages) {
    $installed = $installedVersions[$pkgName]
    
    if (-not $installed) {
        continue  # Package not used in this sample
    }
    
    $latest = $null
    $latestTag = "latest"
    
    switch ($SampleType) {
        "dotnet" {
            $latest = Get-NuGetLatestVersion -PackageName $pkgName -IncludePreRelease $IncludePreRelease
        }
        "python" {
            $latest = Get-PyPILatestVersion -PackageName $pkgName -IncludePreRelease $IncludePreRelease
        }
        "nodejs" {
            $result = Get-NpmLatestVersion -PackageName $pkgName -IncludePreRelease $IncludePreRelease
            if ($result) {
                $latest = $result.version
                $latestTag = $result.tag
            }
        }
    }
    
    if ($latest) {
        $isUpToDate = ($installed -eq $latest) -or ($installed -eq "not-pinned")
        $isPreRelease = $latest -match '(alpha|beta|preview|pre|rc|dev|a\d|b\d|-)'
        
        $result = @{
            package = $pkgName
            installed = $installed
            latest = $latest
            latestTag = $latestTag
            isUpToDate = $isUpToDate
            isPreRelease = $isPreRelease
        }
        
        $validationResults += $result
        
        $statusIcon = if ($isUpToDate) { "✅" } else { "⚠️"; $hasOutdated = $true }
        $preReleaseLabel = if ($isPreRelease) { " (pre-release)" } else { "" }
        
        Write-Host "$statusIcon $pkgName" -ForegroundColor $(if ($isUpToDate) { "Green" } else { "Yellow" })
        Write-Host "   Installed: $installed" -ForegroundColor Gray
        Write-Host "   Latest:    $latest$preReleaseLabel" -ForegroundColor $(if ($isPreRelease) { "Magenta" } else { "Gray" })
    }
}

Write-Host ""

# Summary
$upToDateCount = ($validationResults | Where-Object { $_.isUpToDate }).Count
$outdatedCount = ($validationResults | Where-Object { -not $_.isUpToDate }).Count
$preReleaseCount = ($validationResults | Where-Object { $_.isPreRelease }).Count

Write-Host "=== Validation Summary ===" -ForegroundColor Cyan
Write-Host "Packages checked: $($validationResults.Count)" -ForegroundColor Gray
Write-Host "Up to date: $upToDateCount" -ForegroundColor Green
Write-Host "Outdated: $outdatedCount" -ForegroundColor $(if ($outdatedCount -gt 0) { "Yellow" } else { "Gray" })
Write-Host "Using pre-release: $preReleaseCount" -ForegroundColor $(if ($preReleaseCount -gt 0) { "Magenta" } else { "Gray" })

if ($hasOutdated) {
    Write-Host ""
    Write-Host "⚠️  Some SDK packages are not using the latest version!" -ForegroundColor Yellow
    Write-Host "Consider updating to test against the newest SDK releases." -ForegroundColor Yellow
}

# Output JSON if requested
if ($OutputJson) {
    $output = @{
        samplePath = $SamplePath
        sampleType = $SampleType
        timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        includePreRelease = $IncludePreRelease
        validation = @{
            allUpToDate = (-not $hasOutdated)
            packagesChecked = $validationResults.Count
            upToDate = $upToDateCount
            outdated = $outdatedCount
            usingPreRelease = $preReleaseCount
        }
        packages = $validationResults
    }
    
    $output | ConvertTo-Json -Depth 10
}

# Return exit code based on validation
if ($hasOutdated) {
    exit 1
} else {
    exit 0
}
