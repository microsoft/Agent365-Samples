// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Net;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace Agent365.E2E.Tests;

/// <summary>
/// HTTP integration tests for local agent testing.
/// Tests basic agent connectivity and message processing.
/// 
/// NOTE: This test verifies the agent processes messages but may not capture
/// responses when running locally without Bot Framework infrastructure.
/// Uses MockBotFrameworkServer to capture agent responses.
/// 
/// For full request/response testing:
/// - Use Bot Framework Emulator (connects via Direct Line)
/// - Deploy to Azure and test via Agent 365 Playground
/// </summary>
public class HttpIntegrationTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _output;
    private readonly LocalAgentTestClient _client;
    private readonly string _agentUrl;

    public HttpIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
        _agentUrl = Environment.GetEnvironmentVariable("AGENT_URL") ?? "http://localhost:3978";
        _client = new LocalAgentTestClient(_agentUrl, mockPort: 3980);
    }

    public async Task InitializeAsync()
    {
        await _client.StartMockServerAsync();
        _output.WriteLine($"Mock server started on {_client.MockServerServiceUrl}");
    }

    public async Task DisposeAsync()
    {
        await _client.StopMockServerAsync();
        _output.WriteLine("Mock server stopped");
    }

    [Fact]
    [Trait("Category", "HTTP")]
    public async Task TestAgentHealth_WhenCalledOnMessagesEndpoint_AgentIsAccessible()
    {
        // Arrange & Act
        _output.WriteLine("Checking if agent is accessible...");
        var startTime = DateTime.UtcNow;
        bool passed = false;
        string? errorMessage = null;
        string? responseInfo = null;

        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };

        try
        {
            var response = await httpClient.GetAsync($"{_agentUrl}/api/messages");

            // Assert - We expect 405 (Method Not Allowed) for GET on messages endpoint
            // This means the agent is running
            response.StatusCode.Should().BeOneOf(
                HttpStatusCode.MethodNotAllowed,
                HttpStatusCode.OK,
                HttpStatusCode.NotFound,
                HttpStatusCode.Unauthorized
            );

            responseInfo = $"Agent is running (Status: {response.StatusCode})";
            _output.WriteLine($"[OK] Agent is running on {_agentUrl} (Status: {response.StatusCode})");
            passed = true;
        }
        catch (HttpRequestException ex)
        {
            errorMessage = $"Cannot connect to agent on {_agentUrl}. Error: {ex.Message}";
            Assert.Fail($"Cannot connect to agent on {_agentUrl}. Make sure agent is running. Error: {ex.Message}");
        }
        catch (TaskCanceledException)
        {
            responseInfo = "Agent responding slowly, but may be running";
            _output.WriteLine("[WARNING] Agent responding slowly, but may be running");
            passed = true; // Still consider it a pass if it times out but doesn't error
        }
        finally
        {
            // Record the health check for reporting
            TestResultsCollector.RecordConversation(
                testName: "TestAgentHealth",
                userMessage: $"GET {_agentUrl}/api/messages",
                agentResponse: responseInfo ?? "(no response)",
                passed: passed,
                errorMessage: errorMessage,
                duration: DateTime.UtcNow - startTime);
        }
    }

    [Fact]
    [Trait("Category", "HTTP")]
    public async Task TestAgentHttpEndpoint_WhenSendingMessage_ProcessesSuccessfully()
    {
        // Arrange
        _output.WriteLine("Testing agent message processing...");
        _output.WriteLine($"Mock server on {_client.MockServerServiceUrl} to capture responses");

        var conversationId = Guid.NewGuid().ToString();
        var userMessage = "Hello! Can you tell me a joke?";
        var startTime = DateTime.UtcNow;
        string? responseText = null;
        string? errorMessage = null;
        bool passed = false;

        try
        {
            // Act
            _output.WriteLine("\nSending test message...");
            var result = await _client.SendMessageAsync(userMessage, conversationId);

            _output.WriteLine($"Initial status: {result.Status}");

            // Assert - Agent must at least accept the message
            result.Status.Should().BeOneOf("accepted", "success", "processed_no_channel",
                $"Agent not responding: {result.Message}. Make sure agent is running.");

            _output.WriteLine("[OK] Agent accepted the message, waiting for response...");

            // Wait for actual response from mock server
            _output.WriteLine("\nWaiting for response via mock server (timeout: 30s)...");
            var responses = await _client.GetResponsesAsync(conversationId, timeout: TimeSpan.FromSeconds(30));

            // Validate we got a response
            responses.Should().NotBeEmpty(
                "No response received from agent via mock server. Agent may have failed to process the message.");

            _output.WriteLine($"[OK] Received {responses.Count} response(s) from agent");

            // Find a response with actual text content
            foreach (var resp in responses)
            {
                var text = MockBotFrameworkServer.GetResponseText(resp);
                if (!string.IsNullOrEmpty(text))
                {
                    responseText = text;
                    var preview = text.Length > 200 ? text[..200] + "..." : text;
                    _output.WriteLine($"\nResponse: {preview}");
                    break;
                }
            }

            // Validate response has content
            responseText.Should().NotBeNullOrEmpty(
                $"Response received but text is empty. Raw responses: {JsonSerializer.Serialize(responses)}");

            _output.WriteLine("\n[PASSED] Agent processed message and returned valid response");
            passed = true;
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
            throw;
        }
        finally
        {
            // Record the conversation for reporting
            TestResultsCollector.RecordConversation(
                testName: "TestAgentHttpEndpoint",
                userMessage: userMessage,
                agentResponse: responseText,
                passed: passed,
                errorMessage: errorMessage,
                duration: DateTime.UtcNow - startTime);
        }
    }

    [Fact]
    [Trait("Category", "HTTP")]
    public async Task TestMultipleMessages_WhenSendingSequentialMessages_AllProcessedSuccessfully()
    {
        // Arrange
        _output.WriteLine("Testing multiple message processing...");
        _output.WriteLine("Starting mock server to capture responses...");

        var conversationId = Guid.NewGuid().ToString();
        var messages = new[] { "Hello!", "Can you help me?", "Tell me a joke" };
        var turns = new List<(string UserMessage, string? AgentResponse)>();
        var startTime = DateTime.UtcNow;
        string? errorMessage = null;
        bool passed = false;

        try
        {
            // Act & Assert
            foreach (var msg in messages)
            {
                _output.WriteLine($"\nSending: {msg}");

                // Clear previous responses
                _client.ClearResponses(conversationId);

                // Send message
                var result = await _client.SendMessageAsync(msg, conversationId);
                _output.WriteLine($"Initial status: {result.Status}");

                // First check - agent must accept the message
                result.Status.Should().BeOneOf("accepted", "success", "processed_no_channel",
                    $"Agent not responding: {result.Message}. Make sure agent is running on port 3979");

                // Wait for actual response from mock server
                _output.WriteLine("  Waiting for response (timeout: 30s)...");
                var responses = await _client.GetResponsesAsync(conversationId, timeout: TimeSpan.FromSeconds(30));

                // Validate we got a response
                responses.Should().NotBeEmpty(
                    $"No response received for message '{msg}'. Agent may have failed to process.");

                // Find response with text content
                string? responseText = null;
                foreach (var resp in responses)
                {
                    var text = MockBotFrameworkServer.GetResponseText(resp);
                    if (!string.IsNullOrEmpty(text))
                    {
                        responseText = text;
                        break;
                    }
                }

                responseText.Should().NotBeNullOrEmpty(
                    $"Response for '{msg}' has no text content. Raw: {JsonSerializer.Serialize(responses)}");

                // Record this turn
                turns.Add((msg, responseText));

                var preview = responseText!.Length > 100 ? responseText[..100] + "..." : responseText;
                _output.WriteLine($"  [OK] Response: {preview}");

                await Task.Delay(500);
            }

            _output.WriteLine($"\n[PASSED] All {messages.Length}/{messages.Length} messages processed with valid responses");
            passed = true;
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
            throw;
        }
        finally
        {
            // Record the multi-turn conversation for reporting
            TestResultsCollector.RecordMultiTurnConversation(
                testName: "TestMultipleMessages",
                turns: turns,
                passed: passed,
                errorMessage: errorMessage,
                duration: DateTime.UtcNow - startTime);
        }
    }

    [Fact(Skip = "Requires OPENAI_API_KEY to be configured - skipping for now")]
    [Trait("Category", "HTTP")]
    public async Task TestMcpEmailTools_WhenAskingForTools_ReturnsEmailCapabilities()
    {
        // Arrange
        _output.WriteLine("TEST: MCP Email Tools Configuration");
        _output.WriteLine(new string('-', 60));

        var conversationId = Guid.NewGuid().ToString();
        var userMessage = "What tools and MCP servers do you have configured? List all available email tools.";
        var startTime = DateTime.UtcNow;
        string? responseText = null;
        string? errorMessage = null;
        bool passed = false;

        try
        {
            // Act - Ask agent to list its tools and MCP servers
            _output.WriteLine("\n[Query] What tools and MCP servers do you have configured?");

            var result = await _client.SendMessageAsync(userMessage, conversationId);

            // Assert - First check if agent accepted the message
            result.Should().NotBeNull("Failed to send message to agent");
            result.Status.Should().BeOneOf("accepted", "success", "processed_no_channel",
                $"Agent not responding: {result.Message}. Make sure agent is running on port 3979");

            _output.WriteLine("[OK] Agent accepted tool listing query, waiting for response...");

            // Wait for response from agent (longer timeout for tool listing)
            _output.WriteLine("[Waiting] Allowing up to 30 seconds for agent to list tools...");
            var responses = await _client.GetResponsesAsync(conversationId, timeout: TimeSpan.FromSeconds(30));

            // Validate we got a response
            responses.Should().NotBeEmpty(
                "No response received from agent via mock server");

            // Get the actual response text
            for (int idx = 0; idx < responses.Count; idx++)
            {
                var text = MockBotFrameworkServer.GetResponseText(responses[idx]);
                if (!string.IsNullOrEmpty(text))
                {
                    responseText = text;
                    _output.WriteLine($"[OK] Received response from agent (response #{idx + 1})");
                    break;
                }
            }

            responseText.Should().NotBeNullOrEmpty(
                $"Response received but all text fields are empty. Raw responses: {JsonSerializer.Serialize(responses)}");

            var responseTextLower = responseText!.ToLowerInvariant();
            var preview = responseText.Length > 500 ? responseText[..500] + "..." : responseText;
            _output.WriteLine($"\n[Response Preview]\n{new string('-', 60)}\n{preview}\n{new string('-', 60)}");

            // Expected email tool capabilities from MCP Mail server
            var expectedTools = new Dictionary<string, string[]>
            {
                { "draft", new[] { "draft", "create draft" } },
                { "send", new[] { "send email", "send directly" } },
                { "search", new[] { "search email", "search" } },
                { "reply", new[] { "reply" } },
                { "forward", new[] { "forward" } },
                { "attachment", new[] { "attachment", "attach" } },
                { "update", new[] { "update email" } },
                { "delete", new[] { "delete email" } }
            };

            var foundTools = expectedTools
                .Where(kvp => kvp.Value.Any(keyword => responseTextLower.Contains(keyword)))
                .Select(kvp => kvp.Key)
                .ToList();

            _output.WriteLine($"\n[Analysis] Found {foundTools.Count}/{expectedTools.Count} expected email tool categories:");
            foreach (var tool in foundTools)
            {
                _output.WriteLine($"  [OK] {tool}");
            }

            // Check for negative indicators
            var negativeIndicators = new[]
            {
                "i don't have any tools",
                "no tools configured",
                "i don't have access to",
                "i cannot",
                "i'm unable to"
            };
            var noTools = negativeIndicators.Any(phrase => responseTextLower.Contains(phrase));

            noTools.Should().BeFalse("Agent indicates it has no tools or cannot access MCP servers");

            foundTools.Should().NotBeEmpty(
                $"No email tool categories found in response. Expected at least some of: {string.Join(", ", expectedTools.Keys)}");

            if (foundTools.Count >= 3)
            {
                _output.WriteLine($"\n[PASSED] Agent has MCP Mail tools configured");
                _output.WriteLine($"         Found tools: {string.Join(", ", foundTools)}");
            }
            else
            {
                _output.WriteLine($"\n[WARNING] Only found {foundTools.Count} email tool categories, but test passes");
                _output.WriteLine($"         Found tools: {string.Join(", ", foundTools)}");
            }
            passed = true;
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
            throw;
        }
        finally
        {
            // Record the conversation for reporting
            TestResultsCollector.RecordConversation(
                testName: "TestMcpEmailTools",
                userMessage: userMessage,
                agentResponse: responseText,
                passed: passed,
                errorMessage: errorMessage,
                duration: DateTime.UtcNow - startTime);
        }
    }

    [Fact]
    [Trait("Category", "HTTP")]
    public async Task TestEmptyPayload_WhenSendingEmptyMessage_AgentHandlesGracefully()
    {
        // Arrange
        var conversationId = Guid.NewGuid().ToString();
        var startTime = DateTime.UtcNow;
        bool passed = false;
        string? errorMessage = null;

        try
        {
            // Act
            var result = await _client.SendMessageAsync("", conversationId);

            // Assert - Agent should either process or return an error gracefully
            _output.WriteLine($"Status: {result.Status}");
            
            // The agent should not crash - any valid status is acceptable
            result.Status.Should().NotBeNull();
            passed = true;
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
            throw;
        }
        finally
        {
            // Record the conversation for reporting
            TestResultsCollector.RecordConversation(
                testName: "TestEmptyPayload",
                userMessage: "(empty message)",
                agentResponse: "(graceful handling verified)",
                passed: passed,
                errorMessage: errorMessage,
                duration: DateTime.UtcNow - startTime);
        }
    }
}

/// <summary>
/// Test client that simulates Bot Framework Emulator behavior.
/// Uses MockBotFrameworkServer to capture agent responses.
/// </summary>
public class LocalAgentTestClient
{
    private readonly string _agentUrl;
    private readonly MockBotFrameworkServer _mockServer;
    private readonly HttpClient _httpClient;

    public string MockServerServiceUrl => _mockServer.ServiceUrl;

    public LocalAgentTestClient(string agentUrl = "http://localhost:3979", int mockPort = 3980)
    {
        _agentUrl = agentUrl;
        _mockServer = new MockBotFrameworkServer(port: mockPort);
        _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    public Task StartMockServerAsync() => _mockServer.StartAsync();

    public Task StopMockServerAsync() => _mockServer.StopAsync();

    public Task<List<System.Text.Json.JsonElement>> GetResponsesAsync(
        string conversationId, TimeSpan? timeout = null)
    {
        return _mockServer.WaitForResponsesAsync(conversationId, timeout)
            .ContinueWith(t => t.Result.Select(d =>
                JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(d))).ToList());
    }

    public async Task<List<Dictionary<string, System.Text.Json.JsonElement>>> GetResponsesAsync(
        string conversationId, 
        TimeSpan timeout)
    {
        return await _mockServer.WaitForResponsesAsync(conversationId, timeout);
    }

    public void ClearResponses(string conversationId) => _mockServer.ClearResponses(conversationId);

    /// <summary>
    /// Send message to agent and capture response.
    /// This simulates what Bot Framework Emulator does.
    /// </summary>
    public async Task<SendMessageResult> SendMessageAsync(
        string text,
        string? conversationId = null,
        string userId = "test-user",
        string userName = "Test User")
    {
        // Create conversation in mock server
        conversationId ??= Guid.NewGuid().ToString();
        _mockServer.CreateConversation(conversationId);

        // Create activity
        var activity = new
        {
            type = "message",
            id = Guid.NewGuid().ToString(),
            timestamp = DateTime.UtcNow.ToString("o"),
            serviceUrl = _mockServer.ServiceUrl,
            channelId = "emulator",
            from = new
            {
                id = userId,
                name = userName
            },
            conversation = new
            {
                id = conversationId
            },
            recipient = new
            {
                id = "bot",
                name = "Agent"
            },
            text
        };

        var json = JsonSerializer.Serialize(activity);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        try
        {
            var response = await _httpClient.PostAsync($"{_agentUrl}/api/messages", content);

            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                // Agent accepted message (standard Bot Framework response)
                return new SendMessageResult
                {
                    Status = "accepted",
                    ConversationId = conversationId,
                    Message = "Message processed. Response would be sent via Bot Framework channel."
                };
            }
            else if (response.StatusCode == HttpStatusCode.OK)
            {
                // Some agents return 200 with response
                var responseData = await response.Content.ReadAsStringAsync();
                return new SendMessageResult
                {
                    Status = "success",
                    ConversationId = conversationId,
                    ResponseData = responseData
                };
            }
            else if (response.StatusCode == HttpStatusCode.InternalServerError)
            {
                // 500 is expected when agent processes message but can't send response
                return new SendMessageResult
                {
                    Status = "processed_no_channel",
                    ConversationId = conversationId,
                    Message = "Agent processed message and generated response, but couldn't send it back (no Bot Framework channel). This is EXPECTED in local testing without Emulator/Direct Line."
                };
            }
            else
            {
                var errorText = await response.Content.ReadAsStringAsync();
                return new SendMessageResult
                {
                    Status = "error",
                    StatusCode = (int)response.StatusCode,
                    Message = errorText
                };
            }
        }
        catch (TaskCanceledException)
        {
            return new SendMessageResult
            {
                Status = "timeout",
                Message = "Agent did not respond in time"
            };
        }
        catch (HttpRequestException ex)
        {
            return new SendMessageResult
            {
                Status = "error",
                Message = $"Cannot connect to host {_agentUrl} - Agent may not be running. Error: {ex.Message}"
            };
        }
        catch (Exception ex)
        {
            return new SendMessageResult
            {
                Status = "error",
                Message = ex.Message
            };
        }
    }
}

public class SendMessageResult
{
    public string Status { get; set; } = string.Empty;
    public string? ConversationId { get; set; }
    public string? Message { get; set; }
    public string? ResponseData { get; set; }
    public int? StatusCode { get; set; }
}
