# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Copies the centralized ToolingManifest.json to a sample agent directory.

.DESCRIPTION
    Creates a standardized ToolingManifest.json for E2E testing with MCP servers.

.PARAMETER TargetPath
    The path to the sample agent directory.

.EXAMPLE
    ./Copy-ToolingManifest.ps1 -TargetPath "./python/openai/sample-agent"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
)

$ErrorActionPreference = "Stop"

Write-Host "Copying ToolingManifest.json to: $TargetPath" -ForegroundColor Cyan

# Standard ToolingManifest.json for E2E testing
$manifest = @{
    mcpServers = @(
        @{
            mcpServerName = "mcp_MailTools"
            mcpServerUniqueName = "mcp_MailTools"
        }
    )
}

$manifestPath = Join-Path $TargetPath "ToolingManifest.json"
$manifest | ConvertTo-Json -Depth 5 | Out-File -FilePath $manifestPath -Encoding utf8

Write-Host "ToolingManifest.json created at: $manifestPath" -ForegroundColor Green
Write-Host "Contents:" -ForegroundColor Gray
Get-Content $manifestPath | Write-Host
