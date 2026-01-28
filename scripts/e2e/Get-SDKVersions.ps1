# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Gets the installed SDK versions for Agent 365 and Microsoft Agents packages.

.DESCRIPTION
    This script retrieves and logs the version numbers of installed SDK packages
    for Python, Node.js, or .NET runtimes. It outputs the versions to the console
    and to GitHub Actions step summary if running in CI.

.PARAMETER Runtime
    The runtime to check: 'python', 'nodejs', or 'dotnet'

.PARAMETER WorkingDirectory
    The working directory containing the project files

.EXAMPLE
    .\Get-SDKVersions.ps1 -Runtime python -WorkingDirectory "python/openai/sample-agent"
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('python', 'nodejs', 'dotnet')]
    [string]$Runtime,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
)

$ErrorActionPreference = 'Continue'

Write-Host "=== SDK Version Information ===" -ForegroundColor Cyan
Write-Host "Runtime: $Runtime" -ForegroundColor Gray
Write-Host "Directory: $WorkingDirectory" -ForegroundColor Gray
Write-Host ""

$versions = @()

switch ($Runtime) {
    'python' {
        Write-Host "Checking Python package versions..." -ForegroundColor Yellow
        
        Push-Location $WorkingDirectory
        try {
            # Get installed packages using uv
            $pipList = uv pip list --format=json 2>$null | ConvertFrom-Json
            
            if ($pipList) {
                # Agent 365 SDK packages (check first for exclusion from Agents SDK list)
                $a365Packages = $pipList | Where-Object { 
                    $_.name -like 'microsoft-agents-a365-*' -or 
                    $_.name -like 'microsoft_agents_a365_*'
                }
                
                # Microsoft Agents SDK packages (excluding A365 packages)
                $agentsSdkPackages = $pipList | Where-Object { 
                    $_.name -like 'microsoft-agents-*' -and 
                    $_.name -notlike 'microsoft-agents-a365-*' -and
                    $_.name -notlike 'microsoft_agents_a365_*'
                }
                
                Write-Host ""
                Write-Host "Microsoft Agents SDK Packages:" -ForegroundColor Green
                foreach ($pkg in $agentsSdkPackages) {
                    Write-Host "  $($pkg.name): $($pkg.version)"
                    $versions += [PSCustomObject]@{
                        Category = "Microsoft Agents SDK"
                        Package = $pkg.name
                        Version = $pkg.version
                    }
                }
                
                Write-Host ""
                Write-Host "Microsoft Agent 365 SDK Packages:" -ForegroundColor Green
                foreach ($pkg in $a365Packages) {
                    Write-Host "  $($pkg.name): $($pkg.version)"
                    $versions += [PSCustomObject]@{
                        Category = "Microsoft Agent 365 SDK"
                        Package = $pkg.name
                        Version = $pkg.version
                    }
                }
            }
            else {
                Write-Host "Could not retrieve package list" -ForegroundColor Red
            }
        }
        finally {
            Pop-Location
        }
    }
    
    'nodejs' {
        Write-Host "Checking Node.js package versions..." -ForegroundColor Yellow
        
        Push-Location $WorkingDirectory
        try {
            # Read package.json
            $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
            
            # Get installed versions from node_modules
            $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
            
            # Microsoft Agents SDK packages
            $agentsPackages = @(
                '@microsoft/agents-hosting',
                '@microsoft/agents-activity'
            )
            
            # Agent 365 SDK packages
            $a365Packages = @(
                '@microsoft/agents-a365-notifications',
                '@microsoft/agents-a365-observability',
                '@microsoft/agents-a365-observability-hosting',
                '@microsoft/agents-a365-runtime',
                '@microsoft/agents-a365-tooling',
                '@microsoft/agents-a365-tooling-extensions-claude',
                '@microsoft/agents-a365-tooling-extensions-langchain',
                '@microsoft/agents-a365-tooling-extensions-openai'
            )
            
            Write-Host ""
            Write-Host "Microsoft Agents SDK Packages:" -ForegroundColor Green
            foreach ($pkg in $agentsPackages) {
                # Handle scoped packages (e.g., @microsoft/agents-sdk)
                $pkgPathParts = $pkg -split '/'
                $pkgPath = $nodeModulesPath
                foreach ($part in $pkgPathParts) {
                    $pkgPath = Join-Path $pkgPath $part
                }
                $pkgPath = Join-Path $pkgPath "package.json"
                if (Test-Path $pkgPath) {
                    $pkgJson = Get-Content $pkgPath -Raw | ConvertFrom-Json
                    Write-Host "  $($pkg): $($pkgJson.version)"
                    $versions += [PSCustomObject]@{
                        Category = "Microsoft Agents SDK"
                        Package = $pkg
                        Version = $pkgJson.version
                    }
                }
            }
            
            Write-Host ""
            Write-Host "Microsoft Agent 365 SDK Packages:" -ForegroundColor Green
            foreach ($pkg in $a365Packages) {
                # Handle scoped packages (e.g., @microsoft/agents-a365-runtime)
                $pkgPathParts = $pkg -split '/'
                $pkgPath = $nodeModulesPath
                foreach ($part in $pkgPathParts) {
                    $pkgPath = Join-Path $pkgPath $part
                }
                $pkgPath = Join-Path $pkgPath "package.json"
                if (Test-Path $pkgPath) {
                    $pkgJson = Get-Content $pkgPath -Raw | ConvertFrom-Json
                    Write-Host "  $($pkg): $($pkgJson.version)"
                    $versions += [PSCustomObject]@{
                        Category = "Microsoft Agent 365 SDK"
                        Package = $pkg
                        Version = $pkgJson.version
                    }
                }
            }
        }
        finally {
            Pop-Location
        }
    }
    
    'dotnet' {
        Write-Host "Checking .NET package versions..." -ForegroundColor Yellow
        
        Push-Location $WorkingDirectory
        try {
            # Find .csproj file
            $csproj = Get-ChildItem -Filter "*.csproj" | Select-Object -First 1
            
            if ($csproj) {
                # Get package references from project
                $packages = dotnet list package --format json 2>$null | ConvertFrom-Json
                
                if ($packages -and $packages.projects) {
                    foreach ($project in $packages.projects) {
                        foreach ($framework in $project.frameworks) {
                            foreach ($pkg in $framework.topLevelPackages) {
                                $isAgentsSdk = $pkg.id -like 'Microsoft.Agents.*'
                                $isA365Sdk = $pkg.id -like 'Microsoft.Agents.A365.*'
                                
                                if ($isAgentsSdk -and -not $isA365Sdk) {
                                    Write-Host "  $($pkg.id): $($pkg.resolvedVersion)" -ForegroundColor Gray
                                    $versions += [PSCustomObject]@{
                                        Category = "Microsoft Agents SDK"
                                        Package = $pkg.id
                                        Version = $pkg.resolvedVersion
                                    }
                                }
                                elseif ($isA365Sdk) {
                                    Write-Host "  $($pkg.id): $($pkg.resolvedVersion)" -ForegroundColor Gray
                                    $versions += [PSCustomObject]@{
                                        Category = "Microsoft Agent 365 SDK"
                                        Package = $pkg.id
                                        Version = $pkg.resolvedVersion
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        finally {
            Pop-Location
        }
    }
}

# Output to GitHub Actions step summary if available
if ($env:GITHUB_STEP_SUMMARY) {
    Write-Host ""
    Write-Host "Writing to GitHub Step Summary..." -ForegroundColor Gray
    
    $summary = @"
## SDK Versions ($Runtime)

| Category | Package | Version |
|----------|---------|---------|
"@
    
    foreach ($v in $versions) {
        $summary += "`n| $($v.Category) | ``$($v.Package)`` | ``$($v.Version)`` |"
    }
    
    $summary | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}

# Output versions as JSON for potential downstream use
$versionsJson = $versions | ConvertTo-Json -Compress
Write-Host ""
Write-Host "SDK_VERSIONS_JSON=$versionsJson" -ForegroundColor Gray

return $versions
