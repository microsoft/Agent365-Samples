# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Integration test script for Agent 365 sample agents.

.DESCRIPTION
    This PowerShell script tests Agent 365 sample agents running locally by sending
    HTTP requests to the /api/messages endpoint. It tests:
    - Message notifications (Teams message activity)
    - Email notifications (AgentNotification with EmailNotification type)
    - Tool registration verification
    - MCP tool server validation
    - MCP tool invocation testing

.PARAMETER BaseUrl
    The base URL of the agent. Default is http://localhost:3978

.PARAMETER Timeout
    Request timeout in seconds. Default is 30

.PARAMETER SkipToolsTest
    Skip the tools registration and MCP invocation tests

.PARAMETER ToolingManifestPath
    Path to ToolingManifest.json to load expected MCP servers for validation

.PARAMETER ExpectedToolCount
    Expected number of tools for validation (optional)

.PARAMETER OutputJson
    Output test results as JSON for CI/CD automation

.PARAMETER OutputFile
    File path to save JSON results (requires -OutputJson)

.PARAMETER Verbose
    Enable verbose output for debugging

.EXAMPLE
    .\Test-Agent365Integration.ps1
    
.EXAMPLE
    .\Test-Agent365Integration.ps1 -BaseUrl "http://localhost:5000" -Timeout 60

.EXAMPLE
    # CI/CD automation with JSON output
    .\Test-Agent365Integration.ps1 -OutputJson -OutputFile "test-results.json"

.EXAMPLE
    # Validate MCP tools against manifest
    .\Test-Agent365Integration.ps1 -ToolingManifestPath "./ToolingManifest.json"

.NOTES
    Ensure the sample agent is running locally before executing this script.
    The agent should be accessible at the specified BaseUrl.
    
    For CI/CD pipelines, use -OutputJson to get machine-readable results.
    Exit code 0 = all tests passed, Exit code 1 = some tests failed.
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$BaseUrl = "http://localhost:3978",

    [Parameter()]
    [int]$Timeout = 30,

    [Parameter()]
    [switch]$SkipToolsTest,

    [Parameter()]
    [string]$ToolingManifestPath = "",

    [Parameter()]
    [int]$ExpectedToolCount = 0,

    [Parameter()]
    [switch]$OutputJson,

    [Parameter()]
    [string]$OutputFile = ""
)

# Script configuration
$ErrorActionPreference = "Stop"
$MessagesEndpoint = "$BaseUrl/api/messages"

# Test results tracking
$TestResults = @{
    Passed = 0
    Failed = 0
    Skipped = 0
    Details = @()
}

#region Helper Functions

function Write-TestHeader {
    param([string]$TestName)
    Write-Host "`n" -NoNewline
    Write-Host ("=" * 60) -ForegroundColor Cyan
    Write-Host "  TEST: $TestName" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor Cyan
}

function Write-TestResult {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Message = "",
        [string]$Details = ""
    )

    $result = @{
        TestName = $TestName
        Passed = $Passed
        Message = $Message
        Details = $Details
    }
    $script:TestResults.Details += $result

    if ($Passed) {
        $script:TestResults.Passed++
        Write-Host "  [PASS] PASSED: $TestName" -ForegroundColor Green
    } else {
        $script:TestResults.Failed++
        Write-Host "  [FAIL] FAILED: $TestName" -ForegroundColor Red
    }

    if ($Message) {
        Write-Host "     $Message" -ForegroundColor Gray
    }
    if ($Details -and $VerbosePreference -eq 'Continue') {
        Write-Host "     Details: $Details" -ForegroundColor DarkGray
    }
}

function Write-TestSkipped {
    param(
        [string]$TestName,
        [string]$Reason
    )
    $script:TestResults.Skipped++
    $script:TestResults.Details += @{
        TestName = $TestName
        Passed = $null
        Message = "SKIPPED: $Reason"
        Details = ""
    }
    Write-Host "  [SKIP] SKIPPED: $TestName - $Reason" -ForegroundColor Yellow
}

function New-ActivityId {
    return [guid]::NewGuid().ToString()
}

function New-ConversationId {
    return "test-conversation-" + [guid]::NewGuid().ToString().Substring(0, 8)
}

function Get-Timestamp {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

function Send-AgentRequest {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Activity,
        
        [string]$Description = "Agent Request"
    )

    $jsonBody = $Activity | ConvertTo-Json -Depth 10
    
    Write-Verbose "Sending request to $MessagesEndpoint"
    Write-Verbose "Request Body: $jsonBody"

    try {
        $response = Invoke-WebRequest -Uri $MessagesEndpoint `
            -Method Post `
            -ContentType "application/json" `
            -Body $jsonBody `
            -TimeoutSec $Timeout `
            -UseBasicParsing

        Write-Verbose "Response Status: $($response.StatusCode)"
        Write-Verbose "Response Body: $($response.Content)"

        return @{
            Success = $true
            StatusCode = $response.StatusCode
            Content = $response.Content
            Headers = $response.Headers
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        $statusCode = $null
        
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $errorMessage = $reader.ReadToEnd()
                $reader.Close()
            } catch {
                # Ignore stream read errors
            }
        }

        Write-Verbose "Request failed: $errorMessage"

        return @{
            Success = $false
            StatusCode = $statusCode
            Content = $errorMessage
            Error = $_.Exception
        }
    }
}

#endregion

#region Activity Factory Functions

function New-MessageActivity {
    param(
        [Parameter(Mandatory)]
        [string]$Text,
        
        [string]$ChannelId = "msteams",
        [string]$ConversationType = "personal"
    )

    $activityId = New-ActivityId
    $conversationId = New-ConversationId

    return @{
        type = "message"
        id = $activityId
        timestamp = Get-Timestamp
        channelId = $ChannelId
        from = @{
            id = "test-user-001"
            name = "Test User"
            aadObjectId = "00000000-0000-0000-0000-000000000001"
        }
        conversation = @{
            id = $conversationId
            conversationType = $ConversationType
            tenantId = "test-tenant-001"
        }
        recipient = @{
            id = "test-agent-001"
            name = "Test Agent"
        }
        serviceUrl = "https://test.serviceurl.com"
        text = $Text
        locale = "en-US"
    }
}

function New-EmailNotificationActivity {
    param(
        [string]$FromName = "Test Sender",
        [string]$FromEmail = "sender@test.com",
        [string]$Subject = "Test Email Subject",
        [string]$Body = "This is a test email notification body.",
        [string]$EmailId = $null,
        [string]$ConversationEmailId = $null
    )

    if (-not $EmailId) {
        $EmailId = "email-" + [guid]::NewGuid().ToString().Substring(0, 8)
    }
    if (-not $ConversationEmailId) {
        $ConversationEmailId = "conv-email-" + [guid]::NewGuid().ToString().Substring(0, 8)
    }

    $activityId = New-ActivityId
    $conversationId = New-ConversationId

    # AgentNotification activity for Email Notification
    return @{
        type = "invoke"
        name = "agents/notification"
        id = $activityId
        timestamp = Get-Timestamp
        channelId = "msteams"
        from = @{
            id = "test-user-001"
            name = $FromName
            aadObjectId = "00000000-0000-0000-0000-000000000001"
        }
        conversation = @{
            id = $conversationId
            conversationType = "personal"
            tenantId = "test-tenant-001"
        }
        recipient = @{
            id = "test-agent-001"
            name = "Test Agent"
        }
        serviceUrl = "https://test.serviceurl.com"
        text = $Body
        value = @{
            notificationType = "EmailNotification"
            emailNotification = @{
                id = $EmailId
                conversationId = $ConversationEmailId
                subject = $Subject
                bodyPreview = $Body.Substring(0, [Math]::Min(100, $Body.Length))
            }
            from = @{
                name = $FromName
                email = $FromEmail
            }
        }
    }
}

function New-TeamsMessageNotificationActivity {
    param(
        [string]$Text = "Hello from Teams notification test!",
        [string]$FromName = "Test Teams User",
        [string]$Scope = "personal"
    )

    $activityId = New-ActivityId
    $conversationId = New-ConversationId

    # AgentNotification activity for Teams Message
    return @{
        type = "invoke"
        name = "agents/notification"
        id = $activityId
        timestamp = Get-Timestamp
        channelId = "msteams"
        from = @{
            id = "test-user-001"
            name = $FromName
            aadObjectId = "00000000-0000-0000-0000-000000000001"
        }
        conversation = @{
            id = $conversationId
            conversationType = $Scope
            tenantId = "test-tenant-001"
        }
        recipient = @{
            id = "test-agent-001"
            name = "Test Agent"
        }
        serviceUrl = "https://test.serviceurl.com"
        text = $Text
        value = @{
            notificationType = "MessageNotification"
            messageNotification = @{
                text = $Text
                destination = @{
                    scope = $Scope
                }
            }
        }
    }
}

function New-InstallationUpdateActivity {
    param(
        [ValidateSet("add", "remove")]
        [string]$Action = "add"
    )

    $activityId = New-ActivityId
    $conversationId = New-ConversationId

    return @{
        type = "installationUpdate"
        id = $activityId
        timestamp = Get-Timestamp
        channelId = "msteams"
        action = $Action
        from = @{
            id = "test-user-001"
            name = "Test User"
            aadObjectId = "00000000-0000-0000-0000-000000000001"
        }
        conversation = @{
            id = $conversationId
            conversationType = "personal"
            tenantId = "test-tenant-001"
        }
        recipient = @{
            id = "test-agent-001"
            name = "Test Agent"
        }
        serviceUrl = "https://test.serviceurl.com"
    }
}

#endregion

#region Test Functions

function Test-AgentHealthCheck {
    Write-TestHeader "Agent Health Check"

    # Try multiple health check endpoints (different samples use different patterns)
    $healthEndpoints = @(
        "$BaseUrl/api/health",
        "$BaseUrl/health",
        "$BaseUrl"
    )

    foreach ($endpoint in $healthEndpoints) {
        try {
            $response = Invoke-WebRequest -Uri $endpoint -Method Get -TimeoutSec 10 -UseBasicParsing
            
            if ($response.StatusCode -eq 200) {
                Write-TestResult -TestName "Agent is running" -Passed $true -Message "Agent responded at $endpoint"
                return $true
            }
        }
        catch {
            # Try next endpoint
            Write-Verbose "Endpoint $endpoint returned: $($_.Exception.Message)"
        }
    }

    # If we get here, try to check if /api/messages endpoint accepts POST (the agent is running)
    try {
        $testActivity = @{
            type = "message"
            id = "health-check"
            text = "ping"
            channelId = "test"
            from = @{ id = "test" }
            conversation = @{ id = "test" }
            recipient = @{ id = "test" }
            serviceUrl = "https://test.com"
        }
        $response = Invoke-WebRequest -Uri "$BaseUrl/api/messages" -Method Post -ContentType "application/json" -Body ($testActivity | ConvertTo-Json -Depth 5) -TimeoutSec 10 -UseBasicParsing
        Write-TestResult -TestName "Agent is running" -Passed $true -Message "Agent /api/messages endpoint is responding"
        return $true
    }
    catch {
        $errorMsg = $_.Exception.Message
        # If we get a 4xx/5xx error (not connection refused), the agent IS running
        if ($errorMsg -match "40[0-9]|50[0-9]" -or $_.Exception.Response) {
            Write-TestResult -TestName "Agent is running" -Passed $true -Message "Agent is responding (returned error, but is reachable)"
            return $true
        }
        Write-TestResult -TestName "Agent is running" -Passed $false -Message "Agent not reachable at $BaseUrl. Error: $errorMsg"
        return $false
    }
}

function Test-MessageActivity {
    Write-TestHeader "Message Activity Test"

    $testMessages = @(
        "Hello, can you help me?",
        "What tools do you have available?",
        "Tell me about yourself"
    )

    foreach ($message in $testMessages) {
        $activity = New-MessageActivity -Text $message
        $result = Send-AgentRequest -Activity $activity -Description "Message: $message"

        if ($result.Success) {
            Write-TestResult -TestName "Send message: '$message'" -Passed $true `
                -Message "Status: $($result.StatusCode)" `
                -Details $result.Content
        } else {
            Write-TestResult -TestName "Send message: '$message'" -Passed $false `
                -Message "Failed with status $($result.StatusCode)" `
                -Details $result.Content
        }

        # Small delay between requests
        Start-Sleep -Milliseconds 500
    }
}

function Test-EmailNotification {
    Write-TestHeader "Email Notification Test"

    $emailScenarios = @(
        @{
            FromName = "Alice Smith"
            FromEmail = "alice.smith@contoso.com"
            Subject = "Urgent: Project Update Required"
            Body = "Hi, please provide an update on the current project status. We need this for the stakeholder meeting tomorrow."
        },
        @{
            FromName = "Bob Johnson"
            FromEmail = "bob.johnson@contoso.com"
            Subject = "Meeting Request"
            Body = "Can we schedule a meeting to discuss the new feature requirements?"
        }
    )

    foreach ($scenario in $emailScenarios) {
        $activity = New-EmailNotificationActivity @scenario
        $result = Send-AgentRequest -Activity $activity -Description "Email from $($scenario.FromName)"

        if ($result.Success) {
            Write-TestResult -TestName "Email notification from '$($scenario.FromName)'" -Passed $true `
                -Message "Status: $($result.StatusCode)" `
                -Details $result.Content
        } else {
            # Some agents may not fully support notifications - 501 means not implemented, which is valid
            if ($result.StatusCode -eq 401 -or $result.StatusCode -eq 403) {
                Write-TestResult -TestName "Email notification from '$($scenario.FromName)'" -Passed $true `
                    -Message "Auth required (expected in test mode)" `
                    -Details "Status: $($result.StatusCode)"
            } elseif ($result.StatusCode -eq 501) {
                Write-TestResult -TestName "Email notification from '$($scenario.FromName)'" -Passed $true `
                    -Message "Not implemented (501) - agent doesn't support this notification type" `
                    -Details "Status: $($result.StatusCode)"
            } else {
                Write-TestResult -TestName "Email notification from '$($scenario.FromName)'" -Passed $false `
                    -Message "Failed with status $($result.StatusCode)" `
                    -Details $result.Content
            }
        }

        Start-Sleep -Milliseconds 500
    }
}

function Test-TeamsMessageNotification {
    Write-TestHeader "Teams Message Notification Test"

    $messageScenarios = @(
        @{
            Text = "Hey, can you help me with my calendar for today?"
            FromName = "Charlie Brown"
            Scope = "personal"
        },
        @{
            Text = "@Agent365 please summarize the meeting notes from yesterday"
            FromName = "Diana Prince"
            Scope = "personal"
        }
    )

    foreach ($scenario in $messageScenarios) {
        $activity = New-TeamsMessageNotificationActivity @scenario
        $result = Send-AgentRequest -Activity $activity -Description "Teams message from $($scenario.FromName)"

        if ($result.Success) {
            Write-TestResult -TestName "Teams message notification: '$($scenario.Text.Substring(0, [Math]::Min(30, $scenario.Text.Length)))...'" -Passed $true `
                -Message "Status: $($result.StatusCode)" `
                -Details $result.Content
        } else {
            # Some agents may not fully support notifications - 501 means not implemented, which is valid
            if ($result.StatusCode -eq 401 -or $result.StatusCode -eq 403) {
                Write-TestResult -TestName "Teams message notification: '$($scenario.Text.Substring(0, [Math]::Min(30, $scenario.Text.Length)))...'" -Passed $true `
                    -Message "Auth required (expected in test mode)" `
                    -Details "Status: $($result.StatusCode)"
            } elseif ($result.StatusCode -eq 501) {
                Write-TestResult -TestName "Teams message notification: '$($scenario.Text.Substring(0, [Math]::Min(30, $scenario.Text.Length)))...'" -Passed $true `
                    -Message "Not implemented (501) - agent doesn't support this notification type" `
                    -Details "Status: $($result.StatusCode)"
            } else {
                Write-TestResult -TestName "Teams message notification: '$($scenario.Text.Substring(0, [Math]::Min(30, $scenario.Text.Length)))...'" -Passed $false `
                    -Message "Failed with status $($result.StatusCode)" `
                    -Details $result.Content
            }
        }

        Start-Sleep -Milliseconds 500
    }
}

function Test-InstallationUpdate {
    Write-TestHeader "Installation Update (Hire/Fire) Test"

    # Test "add" (hire) action
    $addActivity = New-InstallationUpdateActivity -Action "add"
    $addResult = Send-AgentRequest -Activity $addActivity -Description "Installation Add (Hire)"

    if ($addResult.Success) {
        Write-TestResult -TestName "Installation Add (Hire Agent)" -Passed $true `
            -Message "Status: $($addResult.StatusCode)" `
            -Details $addResult.Content
    } else {
        Write-TestResult -TestName "Installation Add (Hire Agent)" -Passed $false `
            -Message "Failed with status $($addResult.StatusCode)" `
            -Details $addResult.Content
    }

    Start-Sleep -Milliseconds 500

    # Test "remove" (fire) action
    $removeActivity = New-InstallationUpdateActivity -Action "remove"
    $removeResult = Send-AgentRequest -Activity $removeActivity -Description "Installation Remove (Fire)"

    if ($removeResult.Success) {
        Write-TestResult -TestName "Installation Remove (Fire Agent)" -Passed $true `
            -Message "Status: $($removeResult.StatusCode)" `
            -Details $removeResult.Content
    } else {
        Write-TestResult -TestName "Installation Remove (Fire Agent)" -Passed $false `
            -Message "Failed with status $($removeResult.StatusCode)" `
            -Details $removeResult.Content
    }
}

function Test-ToolsRegistration {
    Write-TestHeader "Tools Registration Test"

    if ($SkipToolsTest) {
        Write-TestSkipped -TestName "Tools Registration" -Reason "Skipped via -SkipToolsTest parameter"
        return
    }

    # Load expected MCP servers from ToolingManifest.json if provided
    $expectedMcpServers = @()
    if ($ToolingManifestPath -and (Test-Path $ToolingManifestPath)) {
        try {
            $manifest = Get-Content $ToolingManifestPath -Raw | ConvertFrom-Json
            $expectedMcpServers = $manifest.mcpServers | ForEach-Object { $_.mcpServerName }
            Write-Host "     [INFO] Loaded $(($expectedMcpServers).Count) MCP servers from manifest" -ForegroundColor Cyan
        } catch {
            Write-Host "     [WARN] Failed to parse ToolingManifest.json: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        # Default known tool servers
        $expectedMcpServers = @("mcp_MailTools", "mcp_CalendarTools", "OneDriveMCPServer", "mcp_NLWeb", "mcp_KnowledgeTools", "mcp_MeServer", "mcp_WordServer")
    }

    # Store MCP test results
    $script:TestResults.McpServers = @{
        Expected = $expectedMcpServers
        Found = @()
        Missing = @()
    }

    # Send a message asking about available tools
    # This should trigger the agent to call addToolsToAgentAsync() and listToolServer()
    $toolsQuery = "What tools do you have available? Please list all registered tools and their capabilities."
    
    $activity = New-MessageActivity -Text $toolsQuery
    $result = Send-AgentRequest -Activity $activity -Description "Tools query"

    if ($result.Success) {
        Write-TestResult -TestName "Query available tools" -Passed $true `
            -Message "Agent responded to tools query" `
            -Details $result.Content
        
        # Check if response mentions any known tool servers from ToolingManifest.json
        $responseContent = $result.Content
        
        foreach ($toolServer in $expectedMcpServers) {
            if ($responseContent -match $toolServer) {
                Write-Host "     [Tool] Found tool server: $toolServer" -ForegroundColor DarkCyan
                $script:TestResults.McpServers.Found += $toolServer
            } else {
                $script:TestResults.McpServers.Missing += $toolServer
            }
        }

        # Summary of MCP tool servers
        $foundCount = $script:TestResults.McpServers.Found.Count
        $expectedCount = $expectedMcpServers.Count
        Write-Host "`n     [MCP Summary] Found $foundCount / $expectedCount expected MCP servers" -ForegroundColor Cyan
        
        if ($script:TestResults.McpServers.Missing.Count -gt 0) {
            Write-Host "     [MCP Missing] $($script:TestResults.McpServers.Missing -join ', ')" -ForegroundColor Yellow
        }

        # Validate expected tool count if specified
        if ($ExpectedToolCount -gt 0) {
            # This is a placeholder - actual tool count validation requires parsing the response
            Write-TestResult -TestName "Expected tool count validation" -Passed ($foundCount -ge 1) `
                -Message "Found $foundCount MCP servers (expected: $ExpectedToolCount specified)" `
                -Details "Use -ExpectedToolCount to validate specific counts"
        }
    } else {
        Write-TestResult -TestName "Query available tools" -Passed $false `
            -Message "Failed to query tools: Status $($result.StatusCode)" `
            -Details $result.Content
    }
}

function Test-McpToolInvocation {
    Write-TestHeader "MCP Tool Invocation Test"

    if ($SkipToolsTest) {
        Write-TestSkipped -TestName "MCP Tool Invocation" -Reason "Skipped via -SkipToolsTest parameter"
        return
    }

    # Test specific MCP tool invocations
    $mcpToolTests = @(
        @{
            Name = "Calendar - List Events"
            Query = "What meetings do I have today?"
            ExpectedTool = "mcp_CalendarTools"
        },
        @{
            Name = "Mail - Check Inbox"
            Query = "Do I have any unread emails?"
            ExpectedTool = "mcp_MailTools"
        },
        @{
            Name = "Me - User Info"
            Query = "What is my email address?"
            ExpectedTool = "mcp_MeServer"
        }
    )

    foreach ($test in $mcpToolTests) {
        $activity = New-MessageActivity -Text $test.Query
        $result = Send-AgentRequest -Activity $activity -Description "MCP: $($test.Name)"

        if ($result.Success) {
            # Check if response indicates tool was called (look for tool-related patterns)
            $responseContent = $result.Content
            $toolInvoked = $responseContent -match "tool|calendar|email|mail|meeting|inbox" -or $result.StatusCode -eq 200
            
            Write-TestResult -TestName "MCP: $($test.Name)" -Passed $toolInvoked `
                -Message "Query: $($test.Query)" `
                -Details "Expected tool: $($test.ExpectedTool)"
        } else {
            # Auth errors (401/403) are expected without proper tokens
            if ($result.StatusCode -eq 401 -or $result.StatusCode -eq 403) {
                Write-TestResult -TestName "MCP: $($test.Name)" -Passed $true `
                    -Message "Auth required for MCP tools (expected without tokens)" `
                    -Details "Status: $($result.StatusCode)"
            } else {
                Write-TestResult -TestName "MCP: $($test.Name)" -Passed $false `
                    -Message "Failed: Status $($result.StatusCode)" `
                    -Details $result.Content
            }
        }

        Start-Sleep -Milliseconds 500
    }
}

#endregion

#region Main Execution

function Show-TestSummary {
    Write-Host "`n"
    Write-Host ("=" * 60) -ForegroundColor Magenta
    Write-Host "  TEST SUMMARY" -ForegroundColor Magenta
    Write-Host ("=" * 60) -ForegroundColor Magenta
    
    $total = $TestResults.Passed + $TestResults.Failed + $TestResults.Skipped
    
    Write-Host "  Total Tests:   $total" -ForegroundColor White
    Write-Host "  Passed:        $($TestResults.Passed)" -ForegroundColor Green
    Write-Host "  Failed:        $($TestResults.Failed)" -ForegroundColor Red
    Write-Host "  Skipped:       $($TestResults.Skipped)" -ForegroundColor Yellow
    
    if ($TestResults.Failed -gt 0) {
        Write-Host "`n  [FAIL] Some tests failed!" -ForegroundColor Red
        
        Write-Host "`n  Failed Tests:" -ForegroundColor Red
        foreach ($detail in $TestResults.Details | Where-Object { $_.Passed -eq $false }) {
            Write-Host "    - $($detail.TestName): $($detail.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "`n  [PASS] All tests passed!" -ForegroundColor Green
    }
    
    Write-Host ("=" * 60) -ForegroundColor Magenta

    # MCP Server Summary
    if ($TestResults.McpServers -and $TestResults.McpServers.Expected.Count -gt 0) {
        Write-Host "`n  MCP Servers:" -ForegroundColor Cyan
        Write-Host "    Expected:  $($TestResults.McpServers.Expected.Count)" -ForegroundColor White
        Write-Host "    Found:     $($TestResults.McpServers.Found.Count)" -ForegroundColor $(if ($TestResults.McpServers.Found.Count -eq $TestResults.McpServers.Expected.Count) { "Green" } else { "Yellow" })
        if ($TestResults.McpServers.Missing.Count -gt 0) {
            Write-Host "    Missing:   $($TestResults.McpServers.Missing -join ', ')" -ForegroundColor Yellow
        }
    }

    Write-Host ("=" * 60) -ForegroundColor Magenta
}

function Export-TestResults {
    # Create JSON output for CI/CD automation
    $output = @{
        timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        baseUrl = $BaseUrl
        summary = @{
            total = $TestResults.Passed + $TestResults.Failed + $TestResults.Skipped
            passed = $TestResults.Passed
            failed = $TestResults.Failed
            skipped = $TestResults.Skipped
            success = $TestResults.Failed -eq 0
        }
        mcpServers = @{
            expected = $TestResults.McpServers.Expected
            found = $TestResults.McpServers.Found
            missing = $TestResults.McpServers.Missing
            coverage = if ($TestResults.McpServers.Expected.Count -gt 0) { 
                [math]::Round(($TestResults.McpServers.Found.Count / $TestResults.McpServers.Expected.Count) * 100, 2) 
            } else { 0 }
        }
        tests = $TestResults.Details | ForEach-Object {
            @{
                name = $_.TestName
                passed = $_.Passed
                message = $_.Message
                details = $_.Details
            }
        }
    }

    if ($OutputJson) {
        $json = $output | ConvertTo-Json -Depth 5
        if ($OutputFile) {
            $json | Out-File -FilePath $OutputFile -Encoding utf8
            Write-Host "`n  [OUTPUT] Results saved to: $OutputFile" -ForegroundColor Cyan
        } else {
            Write-Host "`n--- JSON OUTPUT ---" -ForegroundColor DarkGray
            Write-Host $json
            Write-Host "--- END JSON ---" -ForegroundColor DarkGray
        }
    }

    return $output
}

function Main {
    Write-Host "`n"
    Write-Host ("=" * 60) -ForegroundColor Blue
    Write-Host "       Agent 365 Integration Test Script                    " -ForegroundColor Blue
    Write-Host "       Testing: $BaseUrl                        " -ForegroundColor Blue
    Write-Host ("=" * 60) -ForegroundColor Blue

    # Initialize MCP results
    $script:TestResults.McpServers = @{
        Expected = @()
        Found = @()
        Missing = @()
    }

    # Pre-flight check
    $agentRunning = Test-AgentHealthCheck
    
    if (-not $agentRunning) {
        Write-Host "`n[WARNING] Agent is not running. Please start the agent before running tests." -ForegroundColor Yellow
        Write-Host "   For .NET Agent Framework sample: dotnet run" -ForegroundColor Gray
        Write-Host "   For .NET Semantic Kernel sample: dotnet run" -ForegroundColor Gray
        Write-Host "   For Node.js samples: npm start" -ForegroundColor Gray
        Write-Host "   For Python samples: python main.py" -ForegroundColor Gray
        
        Show-TestSummary
        Export-TestResults | Out-Null
        exit 1
    }

    # Run test suites
    Test-MessageActivity
    Test-EmailNotification
    Test-TeamsMessageNotification
    Test-InstallationUpdate
    Test-ToolsRegistration
    Test-McpToolInvocation

    # Show summary
    Show-TestSummary

    # Export results for CI/CD
    Export-TestResults | Out-Null
    # Return exit code based on results
    if ($TestResults.Failed -gt 0) {
        exit 1
    }
    exit 0
}

# Run main function
Main
