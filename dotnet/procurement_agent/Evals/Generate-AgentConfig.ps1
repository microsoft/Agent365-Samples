#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Generates LocalEvalTool agent configuration from the hello_world_a365_agent source code

.DESCRIPTION
    This script dynamically extracts system prompts, plugin information, and tool definitions
    from the hello_world_a365_agent source code to generate the agent_config.json and mock
    plugin files required by LocalEvalTool. This ensures a single source of truth.

.PARAMETER OutputDir
    The directory where the LocalAgentConfig files will be generated (default: bin/LocalAgentConfig)

.PARAMETER Force
    Force regeneration even if files already exist

.EXAMPLE
    .\Generate-AgentConfig.ps1
    Generate configuration in default location

.EXAMPLE
    .\Generate-AgentConfig.ps1 -OutputDir "custom/path" -Force
    Force regenerate in custom location
#>

param(
    [string]$OutputDir = "bin\LocalAgentConfig",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Get script paths
$ScriptDir = $PSScriptRoot
$AgentRootDir = Split-Path $ScriptDir -Parent
$OutputPath = Join-Path $ScriptDir $OutputDir

Write-Host "🔧 Generating LocalEvalTool Agent Configuration" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""

# Create output directory
if (!(Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
    Write-Host "📁 Created output directory: $OutputPath" -ForegroundColor Yellow
} elseif (!$Force -and (Get-ChildItem -Path $OutputPath -Filter "*.json" -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  Configuration files already exist. Use -Force to regenerate." -ForegroundColor Yellow
    Write-Host "   Directory: $OutputPath" -ForegroundColor Gray
    return
}

Write-Host "📍 Source: $AgentRootDir" -ForegroundColor Gray
Write-Host "📍 Output: $OutputPath" -ForegroundColor Gray
Write-Host ""

# Function: Extract system prompt from AgentInstructions.cs
function Get-SystemPromptFromSource {
    $instructionsFile = Join-Path $AgentRootDir "AgentLogic\AgentInstructions.cs"
    
    if (!(Test-Path $instructionsFile)) {
        Write-Host "❌ AgentInstructions.cs not found at: $instructionsFile" -ForegroundColor Red
        return "You are an AI assistant."
    }

    try {
        $content = Get-Content -Path $instructionsFile -Raw
        
        # Extract the multi-line string from GetInstructions method
        if ($content -match '(?s)GetInstructions\([^)]*\)\s*=>\s*\$"""(.*?)"""\s*\.Trim\(\)') {
            $systemPrompt = $matches[1].Trim()
            # Clean up the extracted string - remove extra whitespace but preserve structure
            $systemPrompt = $systemPrompt -replace '^\s+', '' -replace '\s+$', ''
            # Replace agent placeholder with actual name
            $systemPrompt = $systemPrompt -replace '\{\s*agent\.AgentFriendlyName\s*\}', 'HelloWorld A365 Agent'
            
            Write-Host "✅ Extracted system prompt from AgentInstructions.cs" -ForegroundColor Green
            return $systemPrompt
        } else {
            Write-Host "⚠️  Could not parse system prompt from AgentInstructions.cs, using default" -ForegroundColor Yellow
            return "You are a sales agent named HelloWorld A365 Agent. Help user achieve their objectives."
        }
    } catch {
        Write-Host "❌ Error reading AgentInstructions.cs: $($_.Exception.Message)" -ForegroundColor Red
        return "You are an AI assistant."
    }
}

# Function: Extract plugin information from source files
function Get-PluginInformationFromSource {
    $plugins = @()
    
    # OutlookPlugin
    $outlookFile = Join-Path $AgentRootDir "Plugins\OutlookPlugin.cs"
    if (Test-Path $outlookFile) {
        $outlookContent = Get-Content -Path $outlookFile -Raw
        
        $outlookPlugin = @{
            fileName = "hello_world_outlook_plugin.json"
            pluginName = "HelloWorldOutlookPlugin"
            sourceFile = "Plugins\OutlookPlugin.cs"
            tools = @()
        }
        
        # Extract SendEmailAsync
        if ($outlookContent -match '(?s)SendEmailAsync\([^)]*\)') {
            $outlookPlugin.tools += @{
                toolName = "SendEmailAsync"
                description = "Sends an email to a specified recipient."
                inputs = @(
                    @{ name = "toEmail"; description = "The recipient's email address or AAD Object Id"; type = "string"; required = $true }
                    @{ name = "subject"; description = "The email subject"; type = "string"; required = $true }
                    @{ name = "body"; description = "The email body content"; type = "string"; required = $true }
                )
                output = "Email sent successfully to the specified recipient"
                delay = 1000
            }
        }
        
        # Extract CheckForNewEmailsAsync
        if ($outlookContent -match '(?s)CheckForNewEmailsAsync\([^)]*\)') {
            $outlookPlugin.tools += @{
                toolName = "CheckForNewEmailsAsync"
                description = "Checks for new emails received since a specified date and time."
                inputs = @(
                    @{ name = "sinceDateTime"; description = "The date and time to check for new emails since (ISO 8601 format, e.g., '2025-01-15T09:00:00Z')"; type = "string"; required = $true }
                )
                output = "Found 3 new emails since the specified date. Email details: [Mock email data with subjects, senders, and previews]"
                delay = 800
            }
        }
        
        # Extract GetEmailSummaryAsync
        if ($outlookContent -match '(?s)GetEmailSummaryAsync\([^)]*\)') {
            $outlookPlugin.tools += @{
                toolName = "GetEmailSummaryAsync"
                description = "Gets a summary of recent email activity for the agent."
                inputs = @(
                    @{ name = "days"; description = "Number of days to look back for email activity (default: 7)"; type = "int"; required = $false; defaultValue = "7" }
                )
                output = "Email activity summary: 12 emails received, 8 emails sent, 3 unread messages in the last 7 days"
                delay = 600
            }
        }
        
        $plugins += $outlookPlugin
        Write-Host "✅ Analyzed OutlookPlugin: $($outlookPlugin.tools.Count) tools found" -ForegroundColor Green
    }
    
    # FilePlugin
    $fileFile = Join-Path $AgentRootDir "Plugins\FilePlugin.cs"
    if (Test-Path $fileFile) {
        $fileContent = Get-Content -Path $fileFile -Raw
        
        $filePlugin = @{
            fileName = "hello_world_file_plugin.json"
            pluginName = "HelloWorldFilePlugin"
            sourceFile = "Plugins\FilePlugin.cs"
            tools = @()
        }
        
        # Extract ListSharedFiles
        if ($fileContent -match '(?s)ListSharedFiles\([^)]*\)') {
            $filePlugin.tools += @{
                toolName = "ListSharedFiles"
                description = "Lists all files shared with the agent"
                inputs = @()
                output = "Shared files found: document1.docx (Sales Report Q4), presentation.pptx (Product Demo), spreadsheet.xlsx (Lead Tracking), contract.pdf (Client Agreement Draft)"
                delay = 700
            }
        }
        
        # Extract ReadFile
        if ($fileContent -match '(?s)ReadFile\([^)]*\)') {
            $filePlugin.tools += @{
                toolName = "ReadFile"
                description = "Reads the content of a file from a specified file ID in the agent's OneDrive"
                inputs = @(
                    @{ name = "fileId"; description = "The ID of the file in the agent's OneDrive"; type = "string"; required = $true }
                )
                output = "File content successfully retrieved. [Mock file content based on file type - could be text, document outline, or structured data]"
                delay = 900
            }
        }
        
        $plugins += $filePlugin
        Write-Host "✅ Analyzed FilePlugin: $($filePlugin.tools.Count) tools found" -ForegroundColor Green
    }
    
    # OpenAIPingTool
    $pingFile = Join-Path $AgentRootDir "AgentLogic\Tools\OpenAIPingTool.cs"
    if (Test-Path $pingFile) {
        $pingContent = Get-Content -Path $pingFile -Raw
        
        $pingPlugin = @{
            fileName = "hello_world_ping_plugin.json"
            pluginName = "HelloWorldPingPlugin"
            sourceFile = "AgentLogic\Tools\OpenAIPingTool.cs"
            tools = @()
        }
        
        # Extract Ping method
        if ($pingContent -match '(?s)public static string Ping\([^)]*\)') {
            $pingPlugin.tools += @{
                toolName = "Ping"
                description = "Returns a custom message for testing tool calls."
                inputs = @(
                    @{ name = "message"; description = "The message to echo back"; type = "string"; required = $true }
                )
                output = "Pong! You said: [user message echoed back]"
                delay = 200
            }
        }
        
        $plugins += $pingPlugin
        Write-Host "✅ Analyzed OpenAIPingTool: $($pingPlugin.tools.Count) tools found" -ForegroundColor Green
    }
    
    return $plugins
}

# Function: Generate agent_config.json
function New-AgentConfig {
    param($SystemPrompt, $Plugins)
    
    $pluginFileNames = $Plugins | ForEach-Object { $_.fileName }
    
    return @{
        "_comment" = @(
            "This configuration was automatically generated from the hello_world_a365_agent source code:",
            "- System prompt: Extracted from ProcurementA365Agent.AgentLogic.AgentInstructions.GetInstructions() method",
            "- Plugins: Based on actual plugins found in the agent:",
            "  * OutlookPlugin (Plugins/OutlookPlugin.cs) - Email operations",
            "  * FilePlugin (Plugins/FilePlugin.cs) - File operations", 
            "  * OpenAIPingTool (AgentLogic/Tools/OpenAIPingTool.cs) - Testing tool",
            "- MCP plugins: Empty array as MCP integration is handled dynamically via McpToolDiscovery service",
            "- Plugin JSON files contain mock implementations matching the real plugin signatures",
            "- Generated on: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        )
        "systemPrompt" = $SystemPrompt
        "plugins" = $pluginFileNames
        "mcp_plugins" = @()
    }
}

# Function: Generate plugin JSON files
function New-PluginJson {
    param($Plugin)
    
    return @{
        "pluginName" = $Plugin.pluginName
        "tools" = $Plugin.tools
    }
}

# Main execution
Write-Host "🔍 Extracting system prompt from source..." -ForegroundColor Cyan
$systemPrompt = Get-SystemPromptFromSource

Write-Host ""
Write-Host "🔍 Analyzing plugin source files..." -ForegroundColor Cyan
$plugins = Get-PluginInformationFromSource

Write-Host ""
Write-Host "🔨 Generating configuration files..." -ForegroundColor Cyan

# Generate agent_config.json
$agentConfig = New-AgentConfig -SystemPrompt $systemPrompt -Plugins $plugins
$agentConfigPath = Join-Path $OutputPath "agent_config.json"
$agentConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $agentConfigPath -Encoding UTF8
Write-Host "✅ Generated: agent_config.json" -ForegroundColor Green

# Generate plugin JSON files
foreach ($plugin in $plugins) {
    $pluginJson = New-PluginJson -Plugin $plugin
    $pluginPath = Join-Path $OutputPath $plugin.fileName
    $pluginJson | ConvertTo-Json -Depth 10 | Set-Content -Path $pluginPath -Encoding UTF8
    Write-Host "✅ Generated: $($plugin.fileName) (from $($plugin.sourceFile))" -ForegroundColor Green
}

Write-Host ""
Write-Host "🎉 Agent configuration generation complete!" -ForegroundColor Green
Write-Host "📊 Summary:" -ForegroundColor Yellow
Write-Host "   • agent_config.json: System prompt + plugin references" -ForegroundColor White
Write-Host "   • $($plugins.Count) plugin files: $($plugins | ForEach-Object { $_.tools.Count } | Measure-Object -Sum | Select-Object -ExpandProperty Sum) total tools" -ForegroundColor White
Write-Host "   • Output directory: $OutputPath" -ForegroundColor White
Write-Host ""
Write-Host "💡 These files will be automatically loaded by LocalEvalTool" -ForegroundColor Gray