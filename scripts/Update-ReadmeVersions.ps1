# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Updates the README.md with current SDK versions from all samples.

.DESCRIPTION
    This script extracts SDK version information from package.json, pyproject.toml,
    and .csproj files across all sample projects and updates a marked section in
    the README.md file.

.PARAMETER ReadmePath
    Path to the README.md file (default: README.md in repo root)

.PARAMETER DryRun
    If specified, outputs the new content without modifying the file

.EXAMPLE
    .\Update-ReadmeVersions.ps1
    .\Update-ReadmeVersions.ps1 -DryRun
#>

param(
    [string]$ReadmePath = "README.md",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Define samples to check
$samples = @(
    @{ Name = "Python OpenAI"; Path = "python/openai/sample-agent"; Type = "python" }
    @{ Name = "Python Claude"; Path = "python/claude/sample-agent"; Type = "python" }
    @{ Name = "Node.js OpenAI"; Path = "nodejs/openai/sample-agent"; Type = "nodejs" }
    @{ Name = "Node.js LangChain"; Path = "nodejs/langchain/sample-agent"; Type = "nodejs" }
    @{ Name = ".NET Semantic Kernel"; Path = "dotnet/semantic-kernel/sample-agent"; Type = "dotnet" }
    @{ Name = ".NET Agent Framework"; Path = "dotnet/agent-framework/sample-agent"; Type = "dotnet" }
)

function Get-PythonVersions {
    param([string]$Path)
    
    $versions = @{}
    $pyprojectPath = Join-Path $Path "pyproject.toml"
    
    if (Test-Path $pyprojectPath) {
        $content = Get-Content $pyprojectPath -Raw
        
        # Extract microsoft-agents packages
        $pattern = '(microsoft[-_]agents[-_][a-zA-Z0-9_-]+)\s*[>=<~^]*\s*"?([0-9]+\.[0-9]+\.[0-9]+[^"]*)"?'
        $matches = [regex]::Matches($content, $pattern)
        
        foreach ($match in $matches) {
            $pkgName = $match.Groups[1].Value
            $version = $match.Groups[2].Value -replace '[",\s]', ''
            $versions[$pkgName] = $version
        }
        
        # Try alternate pattern for dependencies section
        $depsPattern = '"(microsoft[-_]agents[-_][a-zA-Z0-9_-]+)[>=<~^]*([0-9]+\.[0-9]+\.[0-9]+[^"]*)"'
        $depsMatches = [regex]::Matches($content, $depsPattern)
        
        foreach ($match in $depsMatches) {
            $pkgName = $match.Groups[1].Value
            $version = $match.Groups[2].Value -replace '[",\s]', ''
            if (-not $versions.ContainsKey($pkgName)) {
                $versions[$pkgName] = $version
            }
        }
    }
    
    return $versions
}

function Get-NodejsVersions {
    param([string]$Path)
    
    $versions = @{}
    $packageJsonPath = Join-Path $Path "package.json"
    
    if (Test-Path $packageJsonPath) {
        $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
        
        $allDeps = @{}
        if ($packageJson.dependencies) {
            $packageJson.dependencies.PSObject.Properties | ForEach-Object {
                $allDeps[$_.Name] = $_.Value
            }
        }
        if ($packageJson.devDependencies) {
            $packageJson.devDependencies.PSObject.Properties | ForEach-Object {
                if (-not $allDeps.ContainsKey($_.Name)) {
                    $allDeps[$_.Name] = $_.Value
                }
            }
        }
        
        foreach ($dep in $allDeps.GetEnumerator()) {
            if ($dep.Key -like '@microsoft/agents*') {
                # Clean version string (remove ^, ~, etc.)
                $version = $dep.Value -replace '[\^~>=<]', ''
                $versions[$dep.Key] = $version
            }
        }
    }
    
    return $versions
}

function Get-DotnetVersions {
    param([string]$Path)
    
    $versions = @{}
    $csprojFiles = Get-ChildItem -Path $Path -Filter "*.csproj" -ErrorAction SilentlyContinue
    
    foreach ($csproj in $csprojFiles) {
        [xml]$xml = Get-Content $csproj.FullName
        
        $packageRefs = $xml.SelectNodes("//PackageReference")
        foreach ($pkg in $packageRefs) {
            $pkgName = $pkg.GetAttribute("Include")
            $pkgVersion = $pkg.GetAttribute("Version")
            
            if ($pkgName -like 'Microsoft.Agents*') {
                $versions[$pkgName] = $pkgVersion
            }
        }
    }
    
    return $versions
}

# Collect all versions
$allVersions = @{}

foreach ($sample in $samples) {
    Write-Host "Checking $($sample.Name)..." -ForegroundColor Cyan
    
    if (-not (Test-Path $sample.Path)) {
        Write-Host "  Path not found: $($sample.Path)" -ForegroundColor Yellow
        continue
    }
    
    $versions = switch ($sample.Type) {
        'python' { Get-PythonVersions -Path $sample.Path }
        'nodejs' { Get-NodejsVersions -Path $sample.Path }
        'dotnet' { Get-DotnetVersions -Path $sample.Path }
    }
    
    if ($versions.Count -gt 0) {
        $allVersions[$sample.Name] = @{
            Type = $sample.Type
            Versions = $versions
        }
        
        foreach ($v in $versions.GetEnumerator()) {
            Write-Host "  $($v.Key): $($v.Value)" -ForegroundColor Gray
        }
    }
}

# Group packages by category
$agentsSdkVersions = @{}
$a365SdkVersions = @{}

foreach ($sample in $allVersions.GetEnumerator()) {
    foreach ($pkg in $sample.Value.Versions.GetEnumerator()) {
        $pkgName = $pkg.Key
        $version = $pkg.Value
        $sampleName = $sample.Key
        
        # Determine category
        $isA365 = $pkgName -match 'a365|A365'
        
        if ($isA365) {
            if (-not $a365SdkVersions.ContainsKey($pkgName)) {
                $a365SdkVersions[$pkgName] = @{ Version = $version; Samples = @() }
            }
            $a365SdkVersions[$pkgName].Samples += $sampleName
        }
        else {
            if (-not $agentsSdkVersions.ContainsKey($pkgName)) {
                $agentsSdkVersions[$pkgName] = @{ Version = $version; Samples = @() }
            }
            $agentsSdkVersions[$pkgName].Samples += $sampleName
        }
    }
}

# Generate markdown table
$markdown = @"

### Microsoft Agents SDK Packages

| Package | Version |
|---------|---------|
"@

# Sort and add Agents SDK packages
$sortedAgentsSdk = $agentsSdkVersions.GetEnumerator() | Sort-Object { $_.Key }
foreach ($pkg in $sortedAgentsSdk) {
    $markdown += "`n| ``$($pkg.Key)`` | ``$($pkg.Value.Version)`` |"
}

$markdown += @"


### Microsoft Agent 365 SDK Packages

| Package | Version |
|---------|---------|
"@

# Sort and add A365 SDK packages
$sortedA365Sdk = $a365SdkVersions.GetEnumerator() | Sort-Object { $_.Key }
foreach ($pkg in $sortedA365Sdk) {
    $markdown += "`n| ``$($pkg.Key)`` | ``$($pkg.Value.Version)`` |"
}

$markdown += "`n"

Write-Host ""
Write-Host "Generated SDK Versions Section:" -ForegroundColor Green
Write-Host $markdown

# Read README and update the section
if (Test-Path $ReadmePath) {
    $readmeContent = Get-Content $ReadmePath -Raw
    
    $startMarker = '<!-- SDK_VERSIONS_START -->'
    $endMarker = '<!-- SDK_VERSIONS_END -->'
    
    if ($readmeContent -match [regex]::Escape($startMarker) -and $readmeContent -match [regex]::Escape($endMarker)) {
        # Replace content between markers
        $pattern = "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))"
        $replacement = "$startMarker`n$markdown`n$endMarker"
        $newContent = $readmeContent -replace $pattern, $replacement
        
        if ($DryRun) {
            Write-Host ""
            Write-Host "=== DRY RUN - Would update README with: ===" -ForegroundColor Yellow
            Write-Host $replacement
        }
        else {
            $newContent | Set-Content $ReadmePath -NoNewline
            Write-Host ""
            Write-Host "README.md updated successfully!" -ForegroundColor Green
        }
    }
    else {
        Write-Host ""
        Write-Host "ERROR: Could not find SDK version markers in README.md" -ForegroundColor Red
        Write-Host "Please add the following markers to README.md:" -ForegroundColor Yellow
        Write-Host "  $startMarker"
        Write-Host "  $endMarker"
        exit 1
    }
}
else {
    Write-Host "ERROR: README.md not found at $ReadmePath" -ForegroundColor Red
    exit 1
}
