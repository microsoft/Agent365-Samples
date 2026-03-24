#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Third-Party Agent365 Evaluation Runner - External evaluation using standard Azure OpenAI
.DESCRIPTION
    This script provides a third-party evaluation framework for Agent365 agents using direct 
    Azure OpenAI calls. It extracts the agent's system prompt and configuration, then simulates
    agent behavior by calling GPT-4.1 directly with the same prompts and settings.
.PARAMETER TestFile
    The test scenario file to run evaluations against (JSON format, from common ../scenarios folder)
.PARAMETER AgentPath
    Path to the Agent365 project directory for extracting configuration (defaults to parent directory)
.PARAMETER EvaluationModel
    Azure OpenAI model for evaluation (default: gpt-4.1)
.PARAMETER SimilarityThreshold
    Threshold for semantic similarity evaluation (0.0-1.0, default: 0.7)
.PARAMETER AssertionsThreshold
    Threshold for assertions evaluation (0.0-1.0, default: 0.6)
.PARAMETER VerboseOutput
    Show detailed execution information

.EXAMPLE
    .\run-evaluation.ps1 -TestFile "agent365_basic_tests.json"
.EXAMPLE
    .\run-evaluation.ps1 -TestFile "agent365_comprehensive_tests.json" -SimilarityThreshold 0.8 -AssertionsThreshold 0.7 -VerboseOutput
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$TestFile,
    
    [string]$AgentPath = "..\\..",
    
    [string]$EvaluationModel = "gpt-4.1",
    
    [decimal]$SimilarityThreshold = 0.7,
    
    [decimal]$AssertionsThreshold = 0.6,
    
    [switch]$VerboseOutput
)

$ErrorActionPreference = "Stop"

# Get script directory for relative paths
$ScriptDir = $PSScriptRoot
$TestPath = Join-Path (Split-Path $ScriptDir -Parent) "scenarios" $TestFile
$ReportsPath = Join-Path (Split-Path $ScriptDir -Parent) "reports"
$AgentProjectPath = Resolve-Path (Join-Path $ScriptDir $AgentPath)

Write-Host "🤖 Agent365 Third-Party Evaluation Runner" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

# Validate input files and directories
if (!(Test-Path $TestPath)) {
    throw "Test file not found: $TestPath"
}

if (!(Test-Path $AgentProjectPath)) {
    throw "Agent project path not found: $AgentProjectPath"
}

# Create reports directory
if (!(Test-Path $ReportsPath)) {
    New-Item -ItemType Directory -Path $ReportsPath -Force | Out-Null
}

# Load and validate test scenarios
Write-Host "📋 Loading test scenarios..." -ForegroundColor Cyan
try {
    $testScenarios = Get-Content $TestPath -Raw | ConvertFrom-Json
    Write-Host "   ✅ Loaded $($testScenarios.tests.Count) test scenarios" -ForegroundColor Green
} catch {
    throw "Failed to parse test scenarios file: $($_.Exception.Message)"
}

# Load agent configuration to get Azure OpenAI settings
Write-Host "🔧 Loading agent configuration..." -ForegroundColor Cyan
$agentConfigPath = Join-Path $AgentProjectPath "appsettings.json"
if (!(Test-Path $agentConfigPath)) {
    throw "Agent configuration not found: $agentConfigPath"
}

try {
    $agentConfig = Get-Content $agentConfigPath -Raw | ConvertFrom-Json
    $azureOpenAIEndpoint = $agentConfig.AzureOpenAIEndpoint
    $modelDeployment = $agentConfig.ModelDeployment
    
    if (!$azureOpenAIEndpoint) {
        throw "AzureOpenAIEndpoint not found in agent configuration"
    }
    
    Write-Host "   ✅ Azure OpenAI Endpoint: $azureOpenAIEndpoint" -ForegroundColor Green
    Write-Host "   ✅ Model Deployment: $modelDeployment" -ForegroundColor Green
} catch {
    throw "Failed to load agent configuration: $($_.Exception.Message)"
}

# Function to send request directly to GPT model (simulating agent behavior)
function Send-DirectGPTRequest {
    param([string]$Prompt, [string]$SystemPrompt, [string]$Endpoint, [string]$Model, [string]$AccessToken, [array]$AvailableTools)
    
    if ($VerboseOutput) {
        Write-Host "   🔍 Sending direct GPT request with system prompt and tools" -ForegroundColor Gray
    }
    
    try {
        # Build tools definition for the prompt
        $toolsDefinition = ""
        if ($AvailableTools.Count -gt 0) {
            $toolsDefinition = "`n`n# Available Tools`nYou have access to the following tools to help complete tasks:`n`n"
            
            foreach ($tool in $AvailableTools) {
                $toolsDefinition += "## $($tool.pluginName) - $($tool.toolName)`n"
                $toolsDefinition += "**Description:** $($tool.description)`n"
                
                if ($tool.inputs -and $tool.inputs.Count -gt 0) {
                    $toolsDefinition += "**Parameters:**`n"
                    foreach ($input in $tool.inputs) {
                        $required = if ($input.required) { " (required)" } else { " (optional)" }
                        $default = if ($input.defaultValue) { ", default: $($input.defaultValue)" } else { "" }
                        $toolsDefinition += "- `$($input.name)` ($($input.type)$default): $($input.description)$required`n"
                    }
                } else {
                    $toolsDefinition += "**Parameters:** None`n"
                }
                $toolsDefinition += "`n"
            }
            
            $toolsDefinition += @"
When you need to use a tool, indicate it clearly in your response using this format:
**TOOL_CALL: [PluginName-ToolName]**
Parameters: {parameter_name: "value", parameter_name2: "value2"}

For example:
**TOOL_CALL: HelloWorldOutlookPlugin-SendEmailAsync**
Parameters: {toEmail: "user@example.com", subject: "Test", body: "Hello"}

You can use multiple tools in a single response if needed.
"@
        }
        
        # Call GPT-4.1 directly with the agent's system prompt and available tools
        $fullPrompt = @"
$SystemPrompt$toolsDefinition

User: $Prompt
"@
        
        $response = Invoke-AzureOpenAI -Prompt $fullPrompt -Endpoint $Endpoint -Model $Model -AccessToken $AccessToken
        
        Write-Host "   ✅ Direct GPT response received" -ForegroundColor Green
        return $response
        
    } catch {
        Write-Host "   ❌ Error calling GPT model: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# Function to parse tool calls from agent response
function Parse-ToolCalls {
    param([string]$Response)
    
    $toolCalls = @()
    
    # Match both markdown (**TOOL_CALL:**) and HTML (<strong>TOOL_CALL:</strong>) formats
    $patterns = @(
        '\*\*TOOL_CALL:\s*([^*]+)\*\*',
        '<strong>TOOL_CALL:\s*([^<]+)</strong>'
    )
    
    foreach ($pattern in $patterns) {
        if ($Response -match $pattern) {
            $toolCallMatches = [regex]::Matches($Response, $pattern)
            
            foreach ($match in $toolCallMatches) {
                $toolCall = $match.Groups[1].Value.Trim()
                
                # Extract plugin and tool name
                if ($toolCall -match '([^-]+)-(.+)') {
                    $pluginName = $matches[1].Trim()
                    $functionName = $matches[2].Trim()
                    
                    # Try to extract parameters from the response text after the tool call
                    $parameters = @{}
                    $paramMatch = [regex]::Match($Response, [regex]::Escape($match.Value) + '\s*\n?\s*Parameters:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                    
                    if ($paramMatch.Success) {
                        $paramStr = $paramMatch.Groups[1].Value.Trim()
                        if ($paramStr) {
                            # Parse individual parameters using simple regex for key: "value" pairs
                            $paramMatches = [regex]::Matches($paramStr, '(\w+):\s*"([^"]*(?:\\.[^"]*)*)"')
                            foreach ($pMatch in $paramMatches) {
                                $key = $pMatch.Groups[1].Value
                                $value = $pMatch.Groups[2].Value
                                # Unescape common escape sequences
                                $value = $value -replace '\\"', '"' -replace '\\n', "`n" -replace '\\r', "`r"
                                $parameters[$key] = $value
                            }
                            
                            # If no parameters were parsed but we have content, store as raw
                            if ($parameters.Count -eq 0) {
                                $parameters["raw"] = $paramStr
                            }
                        }
                    }
                    
                    $toolCallObj = [PSCustomObject]@{
                        pluginName = $pluginName
                        fullFunctionName = $toolCall
                        functionName = $functionName
                        inputParameters = $parameters
                    }
                    
                    $toolCalls += $toolCallObj
                }
            }
        }
    }
    
    return $toolCalls
}

# Function to evaluate response using Azure OpenAI
function Invoke-ResponseEvaluation {
    param(
        [string]$Prompt,
        [string]$AgentResponse, 
        [string]$ExpectedResponse,
        [string]$Endpoint,
        [string]$Model,
        [decimal]$SimilarityThreshold,
        [decimal]$AssertionsThreshold,
        [string]$AccessToken,
        [array]$FunctionCalls = @(),
        [PSCustomObject]$test
    )
    
    # Similarity evaluation prompt
    $similarityPrompt = @"
You are an expert evaluator tasked with measuring the semantic similarity between two responses.

Please evaluate how similar the ACTUAL response is to the EXPECTED response on a scale from 0.0 to 1.0, where:
- 1.0 = Identical meaning, even if worded differently
- 0.8-0.9 = Very similar meaning with minor differences
- 0.6-0.7 = Moderately similar meaning
- 0.4-0.5 = Some similarity but notable differences
- 0.2-0.3 = Little similarity
- 0.0-0.1 = No meaningful similarity

Consider:
- Semantic meaning over exact wording
- Key facts and information conveyed
- Overall intent and purpose
- Logical structure and reasoning

EXPECTED Response:
$ExpectedResponse

ACTUAL Response:
$AgentResponse

Please respond with a JSON object in this exact format:
{
  "score": 0.85,
  "reasoning": "Brief explanation of your evaluation and the key factors that influenced the score"
}
"@

    # Build function calls information for the prompt
    $functionCallsInfo = "No function calls were made"
    if ($FunctionCalls -and $FunctionCalls.Count -gt 0) {
        $callsText = @()
        foreach ($call in $FunctionCalls) {
            $params = if ($call.inputParameters) { ($call.inputParameters | ConvertTo-Json -Compress) } else { "{}" }
            $callsText += "- $($call.fullFunctionName) with parameters: $params"
        }
        $functionCallsInfo = $callsText -join "`n"
    }

    # Assertions evaluation prompt
    $assertionsPrompt = @"
You are an expert evaluator for AI system testing. You need to evaluate how well the AI response satisfies the specific assertions for this test.

**Original Prompt:** $Prompt

**AI Response:** $AgentResponse

**Expected Response (for reference):** $ExpectedResponse

**Function Calls Made:** $functionCallsInfo

**Assertions to Evaluate:**
$($test.assertions | ForEach-Object { "- $_" } | Out-String)

Evaluate how well the AI response satisfies ALL the specified assertions. Consider:
1. Does the response meet each specific assertion requirement?
2. Are function calls used appropriately when assertions require them?
3. Does the content and behavior align with what the assertions expect?

Provide an overall score from 0.0 to 1.0 where:
1.0 = All assertions are completely satisfied
0.8-0.9 = Most assertions satisfied with minor gaps
0.6-0.7 = Some assertions satisfied, some partially met
0.4-0.5 = Few assertions satisfied, significant gaps
0.0-0.3 = Most or all assertions not satisfied

Respond with a JSON object in this exact format:
{
  "score": 0.8,
  "reasoning": "Brief explanation of which assertions are satisfied and any gaps"
}
"@

    $results = @{
        SimilarityScore = 0.0
        QualityScore = 0.0
        SimilarityPass = $false
        QualityPass = $false
        SimilarityReasoning = $null
        QualityReasoning = $null
        Error = $null
    }
    
    try {
        # Evaluate similarity
        $similarityResponse = Invoke-AzureOpenAI -Prompt $similarityPrompt -Endpoint $Endpoint -Model $Model -AccessToken $AccessToken
        
        # Try to parse JSON response first, fall back to simple number parsing
        try {
            if ($VerboseOutput) {
                Write-Host "      Raw Similarity Response: $similarityResponse" -ForegroundColor Gray
            }
            $similarityJson = $similarityResponse | ConvertFrom-Json
            if ($similarityJson.score) {
                $results.SimilarityScore = [decimal]$similarityJson.score
                $results.SimilarityPass = $results.SimilarityScore -ge $SimilarityThreshold
                # Store reasoning if available for enhanced feedback
                if ($similarityJson.reasoning) {
                    $results.SimilarityReasoning = $similarityJson.reasoning
                    if ($VerboseOutput) {
                        Write-Host "      Similarity Reasoning: $($similarityJson.reasoning)" -ForegroundColor Gray
                    }
                }
            }
        } catch {
            if ($VerboseOutput) {
                Write-Host "      JSON Parse Failed for Similarity: $($_.Exception.Message)" -ForegroundColor Yellow
            }
            # Fallback to simple number parsing for backwards compatibility
            if ($similarityResponse -match '(\d+\.?\d*)') {
                $results.SimilarityScore = [decimal]$matches[1]
                $results.SimilarityPass = $results.SimilarityScore -ge $SimilarityThreshold
            }
        }
        
        # Evaluate assertions
        $assertionsResponse = Invoke-AzureOpenAI -Prompt $assertionsPrompt -Endpoint $Endpoint -Model $Model -AccessToken $AccessToken
        
        # Try to parse JSON response first, fall back to simple number parsing
        try {
            if ($VerboseOutput) {
                Write-Host "      Raw Assertions Response: $assertionsResponse" -ForegroundColor Gray
            }
            $assertionsJson = $assertionsResponse | ConvertFrom-Json
            if ($assertionsJson.score -ne $null) {
                # Use 0.0-1.0 scale directly (no conversion needed)
                $results.QualityScore = [decimal]$assertionsJson.score
                $results.QualityPass = $results.QualityScore -ge $AssertionsThreshold
                # Store reasoning if available for enhanced feedback
                if ($assertionsJson.reasoning) {
                    $results.QualityReasoning = $assertionsJson.reasoning
                    if ($VerboseOutput) {
                        Write-Host "      Assertions Reasoning: $($assertionsJson.reasoning)" -ForegroundColor Gray
                    }
                }
            }
        } catch {
            if ($VerboseOutput) {
                Write-Host "      JSON Parse Failed for Assertions: $($_.Exception.Message)" -ForegroundColor Yellow
            }
            # Fallback to simple number parsing for backwards compatibility
            if ($assertionsResponse -match '(\d+\.?\d*)') {
                $results.QualityScore = [decimal]$matches[1]
                $results.QualityPass = $results.QualityScore -ge $AssertionsThreshold
            }
        }
        
    } catch {
        $results.Error = $_.Exception.Message
    }
    
    return $results
}

# Function to call Azure OpenAI
function Invoke-AzureOpenAI {
    param(
        [string]$Prompt,
        [string]$Endpoint,
        [string]$Model,
        [string]$AccessToken
    )
    
    $headers = @{
        "Authorization" = "Bearer $AccessToken"
        "Content-Type" = "application/json"
    }
    
    $body = @{
        messages = @(
            @{
                role = "user"
                content = $Prompt
            }
        )
        max_tokens = 500
        temperature = 0.7
    } | ConvertTo-Json -Depth 3
    
    $uri = "$Endpoint/openai/deployments/$Model/chat/completions?api-version=2024-02-15-preview"
    
    $response = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -Body $body
    return $response.choices[0].message.content
}

# Function to get Azure access token
function Get-AzureAccessToken {
    try {
        # Try to get token using Azure CLI
        $tokenResponse = az account get-access-token --resource https://cognitiveservices.azure.com/ --query accessToken --output tsv 2>$null
        if ($tokenResponse -and $tokenResponse -ne "") {
            return $tokenResponse
        }
    } catch {
        # Fall back to other methods if Azure CLI fails
    }
    
    # Try using Azure PowerShell module
    try {
        $context = Get-AzContext -ErrorAction SilentlyContinue
        if ($context) {
            $token = [Microsoft.Azure.Commands.Common.Authentication.AzureSession]::Instance.AuthenticationFactory.Authenticate($context.Account, $context.Environment, $context.Tenant.Id, $null, "Never", $null, "https://cognitiveservices.azure.com/").AccessToken
            return $token
        }
    } catch {
        # Continue to manual token instruction
    }
    
    throw "Unable to obtain Azure access token. Please ensure you are logged in with 'az login' or 'Connect-AzAccount'"
}

# Create bin directory and generate agent configuration using shared script
$binPath = Join-Path $ScriptDir "bin"
if (!(Test-Path $binPath)) {
    New-Item -ItemType Directory -Path $binPath -Force | Out-Null
}

Write-Host "🔧 Generating agent configuration files..." -ForegroundColor Cyan

# Create LocalAgentConfig directory
$configDir = Join-Path $binPath "LocalAgentConfig"
if (!(Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

# Use the shared Generate-AgentConfig.ps1 script
$generateScript = Join-Path (Split-Path $ScriptDir -Parent) "Generate-AgentConfig.ps1"
if (Test-Path $generateScript) {
    try {
        # Use relative path from Evals directory to 3P Evals bin
        & $generateScript -OutputDir "3P Evals\bin\LocalAgentConfig" -Force
        Write-Host "   ✅ Generated agent configuration files using shared script" -ForegroundColor Green
    } catch {
        Write-Host "   ⚠️  Warning: Failed to generate agent configuration: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "   Proceeding with default configuration..." -ForegroundColor Gray
    }
} else {
    Write-Host "   ⚠️  Generate-AgentConfig.ps1 not found at $generateScript" -ForegroundColor Yellow
}

# Load the generated agent_config.json to get the system prompt and available tools
$agentConfigPath = Join-Path $configDir "agent_config.json"
$systemPrompt = "You are a helpful AI assistant."  # Default fallback
$availableTools = @()

if (Test-Path $agentConfigPath) {
    try {
        $agentConfig = Get-Content $agentConfigPath -Raw | ConvertFrom-Json
        $systemPrompt = $agentConfig.systemPrompt
        Write-Host "   ✅ Loaded system prompt from generated configuration" -ForegroundColor Green
        
        # Load available tools from plugin files
        foreach ($pluginFile in $agentConfig.plugins) {
            $pluginPath = Join-Path $configDir $pluginFile
            if (Test-Path $pluginPath) {
                try {
                    $pluginConfig = Get-Content $pluginPath -Raw | ConvertFrom-Json
                    foreach ($tool in $pluginConfig.tools) {
                        $availableTools += @{
                            pluginName = $pluginConfig.pluginName
                            toolName = $tool.toolName
                            description = $tool.description
                            inputs = $tool.inputs
                        }
                    }
                } catch {
                    Write-Host "   ⚠️  Warning: Failed to load plugin file $pluginFile" -ForegroundColor Yellow
                }
            }
        }
        
        if ($availableTools.Count -gt 0) {
            Write-Host "   ✅ Loaded $($availableTools.Count) available tools from plugins" -ForegroundColor Green
        }
    } catch {
        Write-Host "   ⚠️  Failed to load generated agent config, using default system prompt: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

try {
    # Get Azure access token for evaluation
    Write-Host "🔐 Obtaining Azure access token..." -ForegroundColor Cyan
    $accessToken = Get-AzureAccessToken
    Write-Host "   ✅ Access token obtained" -ForegroundColor Green
    
    # Run evaluations
    Write-Host "🧪 Running evaluations..." -ForegroundColor Cyan
    $results = @()
    $passedTests = 0
    $totalTests = $testScenarios.tests.Count
    
    foreach ($test in $testScenarios.tests) {
        Write-Host "   📝 Testing: $($test.test_id) - $($test.description)" -ForegroundColor White
        
        # Send request directly to GPT model using agent's system prompt with available tools
        $agentResponse = Send-DirectGPTRequest -Prompt $test.prompt -SystemPrompt $systemPrompt -Endpoint $azureOpenAIEndpoint -Model $EvaluationModel -AccessToken $accessToken -AvailableTools $availableTools

        if ($agentResponse) {
            # Parse tool calls from response
            $functionCalls = Parse-ToolCalls -Response $agentResponse
            
            # Evaluate response
            $evaluation = Invoke-ResponseEvaluation -Prompt $test.prompt -AgentResponse $agentResponse -ExpectedResponse $test.expected_response -Endpoint $azureOpenAIEndpoint -Model $EvaluationModel -SimilarityThreshold $SimilarityThreshold -AssertionsThreshold $AssertionsThreshold -AccessToken $accessToken -FunctionCalls $functionCalls -test $test
            
            $testPassed = $evaluation.SimilarityPass -and $evaluation.QualityPass
            if ($testPassed) { $passedTests++ }
            
            $result = [PSCustomObject]@{
                TestId = $test.test_id
                Category = $test.category
                Description = $test.description
                Prompt = $test.prompt
                ExpectedResponse = $test.expected_response
                AgentResponse = $agentResponse
                FunctionCalls = $functionCalls
                SimilarityScore = $evaluation.SimilarityScore
                QualityScore = $evaluation.QualityScore
                SimilarityPass = $evaluation.SimilarityPass
                QualityPass = $evaluation.QualityPass
                SimilarityReasoning = $evaluation.SimilarityReasoning
                QualityReasoning = $evaluation.QualityReasoning
                OverallPass = $testPassed
                passed = $testPassed
                Error = $evaluation.Error
                Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            }
            
            $results += $result
            
            # Display results
            $statusIcon = if ($testPassed) { "✅" } else { "❌" }
            Write-Host "      $statusIcon Similarity: $($evaluation.SimilarityScore.ToString("F2")) Assertions: $($evaluation.QualityScore.ToString("F2"))" -ForegroundColor $(if ($testPassed) { "Green" } else { "Red" })
            
            if ($VerboseOutput) {
                Write-Host "         Agent Response: $($agentResponse.Substring(0, [Math]::Min(100, $agentResponse.Length)))..." -ForegroundColor Gray
            }
        } else {
            $result = @{
                TestId = $test.test_id
                Category = $test.category
                Description = $test.description
                Prompt = $test.prompt
                ExpectedResponse = $test.expected_response
                AgentResponse = "ERROR: No response received"
                SimilarityScore = 0.0
                QualityScore = 0.0
                SimilarityPass = $false
                QualityPass = $false
                OverallPass = $false
                Error = "Agent did not respond"
                Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            }
            
            $results += $result
            Write-Host "      ❌ No response received from agent" -ForegroundColor Red
        }
    }
    
    # Generate reports in 1P-compatible format
    Write-Host "📊 Generating evaluation reports..." -ForegroundColor Cyan
    
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $jsonReportPath = Join-Path $ReportsPath "evaluation_report_$timestamp.json"
    $txtReportPath = Join-Path $ReportsPath "evaluation_report_$timestamp.txt"
    
    # Calculate category breakdown
    $categoryStats = @{}
    foreach ($result in $results) {
        if (!$categoryStats.ContainsKey($result.Category)) {
            $categoryStats[$result.Category] = @{ Total = 0; Passed = 0; AvgScore = 0 }
        }
        $categoryStats[$result.Category].Total++
        if ($result.OverallPass) {
            $categoryStats[$result.Category].Passed++
        }
        $categoryStats[$result.Category].AvgScore += ($result.SimilarityScore + $result.QualityScore) / 2
    }
    foreach ($cat in $categoryStats.Keys) {
        $categoryStats[$cat].AvgScore = $categoryStats[$cat].AvgScore / $categoryStats[$cat].Total
    }
    
    # Generate JSON report (1P format)
    $jsonReport = @{
        generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
        summary = @{
            totalTests = $totalTests
            passedTests = $passedTests
            failedTests = $totalTests - $passedTests
            errorTests = 0
            passRate = [Math]::Round($passedTests / $totalTests, 4)
            averageScore = [Math]::Round(($results | ForEach-Object { ($_.SimilarityScore + $_.QualityScore) / 2 } | Measure-Object -Average).Average, 2)
        }
        testResults = @()
    }
    
    foreach ($result in $results) {
        $testResult = @{
            testId = $result.TestId
            prompt = $result.Prompt
            expectedResponse = $result.ExpectedResponse
            actualResponse = $result.AgentResponse
            category = $result.Category
            description = $result.Description
            executedAt = (Get-Date $result.Timestamp).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
            responseTime = "00:00:00"  # 3P doesn't measure response time like 1P
            passed = $result.OverallPass
            isError = $false
            errorMessage = if ($result.Error) { $result.Error } else { "" }
            functionCalls = @($result.FunctionCalls)  # Tool calls parsed from agent response (ensure array)
            availableToolDefinitions = "Third-party evaluation via direct GPT simulation"
            originalTest = @{
                prompt = $result.Prompt
                expected_response = $result.ExpectedResponse
                test_id = $result.TestId
                category = $result.Category
                description = $result.Description
            }
            evaluationResults = @(
                @{
                    evaluatorName = "SimilarityEvaluator"
                    score = $result.SimilarityScore
                    passed = $result.SimilarityPass
                    passingScore = $SimilarityThreshold
                    feedback = if ($result.SimilarityReasoning) { $result.SimilarityReasoning } else { "Semantic similarity evaluation via Azure OpenAI GPT-4.1" }
                }
                @{
                    evaluatorName = "AssertionsEvaluator"
                    score = $result.QualityScore
                    passed = $result.QualityPass
                    passingScore = $AssertionsThreshold
                    feedback = if ($result.QualityReasoning) { $result.QualityReasoning } else { "Assertions evaluation via Azure OpenAI GPT-4.1" }
                }
            )
            overallScore = [Math]::Round(($result.SimilarityScore + $result.QualityScore) / 2, 2)
        }
        $jsonReport.testResults += $testResult
    }
    
    $jsonReport | ConvertTo-Json -Depth 10 | Set-Content $jsonReportPath
    
    # Generate TXT report (1P format)
    $txtContent = @"
AI Prompt Evaluation Report
===================================================
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Evaluation Type: Third-Party (Direct GPT Simulation)

SUMMARY
-------
Total Tests: $totalTests
Passed: $passedTests ($([Math]::Round(($passedTests / $totalTests) * 100, 1))%)
Failed: $($totalTests - $passedTests)
Errors: 0
Average Score: $([Math]::Round(($results | ForEach-Object { ($_.SimilarityScore + $_.QualityScore) / 2 } | Measure-Object -Average).Average, 2))

CATEGORY BREAKDOWN
------------------
"@
    
    foreach ($cat in $categoryStats.Keys | Sort-Object) {
        $stats = $categoryStats[$cat]
        $txtContent += "`n${cat}: $($stats.Passed)/$($stats.Total) ($([Math]::Round(($stats.Passed / $stats.Total) * 100, 1))%) - Avg Score: $([Math]::Round($stats.AvgScore, 2))"
    }
    
    $txtContent += "`n`nDETAILED RESULTS`n----------------"
    
    foreach ($result in $results) {
        $overallScore = [Math]::Round(($result.SimilarityScore + $result.QualityScore) / 2, 2)
        $status = if ($result.OverallPass) { "PASS" } else { "FAIL" }
        
        $txtContent += @"

Test ID: $($result.TestId)
Category: $($result.Category)
Description: $($result.Description)
Overall Result: $status (Score: $overallScore)
Response Time: N/A (3P Evaluation)
Evaluator Results:
  SimilarityEvaluator: $($result.SimilarityScore) (Pass: $($result.SimilarityPass), Threshold: $SimilarityThreshold)
  AssertionsEvaluator: $($result.QualityScore) (Pass: $($result.QualityPass), Threshold: $AssertionsThreshold)
--------------------------------------------------------------------------------
"@
    }
    
    $txtContent | Set-Content $txtReportPath
    
    # Summary
    Write-Host ""
    Write-Host "📈 Evaluation Summary" -ForegroundColor Green
    Write-Host "====================" -ForegroundColor Green
    Write-Host "   Total Tests: $totalTests" -ForegroundColor White
    Write-Host "   Passed: $passedTests" -ForegroundColor Green
    Write-Host "   Failed: $($totalTests - $passedTests)" -ForegroundColor Red
    Write-Host "   Pass Rate: $([Math]::Round(($passedTests / $totalTests) * 100, 2))%" -ForegroundColor White
    Write-Host ""
    Write-Host "📁 Reports Generated:" -ForegroundColor Cyan
    Write-Host "   JSON: $jsonReportPath" -ForegroundColor White
    Write-Host "   TXT: $txtReportPath" -ForegroundColor White

} finally {
    # Configuration files are preserved in bin/ directory for inspection
    Write-Host "� Configuration files available in: $binPath" -ForegroundColor Cyan
}

# Generate interactive results viewer
Write-Host ""
Write-Host "🌐 Generating results viewer..." -ForegroundColor Cyan
$resultsViewerScript = Join-Path (Split-Path $ScriptDir -Parent) "ResultsViewer\Generate-ResultsViewer.ps1"

if (Test-Path $resultsViewerScript) {
    try {
        # Always generate and open the results viewer
        & $resultsViewerScript -Force -Open
        Write-Host "✅ Results viewer generated and opened successfully" -ForegroundColor Green
    } catch {
        Write-Host "⚠️  Warning: Failed to generate results viewer: $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Results viewer generator not found at: $resultsViewerScript" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "📊 View Results:" -ForegroundColor Cyan
if (Test-Path (Join-Path (Split-Path $ScriptDir -Parent) "ResultsViewer\index.html")) {
    Write-Host "   🌐 Interactive viewer: ../ResultsViewer/index.html" -ForegroundColor White
}
Write-Host "   📁 Reports directory: $((Split-Path $ScriptDir -Parent))\reports" -ForegroundColor White

Write-Host ""
Write-Host "🎉 Evaluation completed!" -ForegroundColor Green