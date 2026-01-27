// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Text.Json;

namespace Agent365.E2E.Tests;

/// <summary>
/// Collects and saves test results to a JSON file for reporting.
/// This enables integration with CI/CD pipelines and test result analysis.
/// </summary>
public static class TestResultsCollector
{
    private static readonly object _lock = new();
    private static readonly List<TestConversation> _conversations = new();
    private static bool _initialized = false;

    private static string GetOutputPath()
    {
        var dir = Environment.GetEnvironmentVariable("TEST_RESULTS_DIR") 
            ?? Path.Combine(Directory.GetCurrentDirectory(), "TestResults");
        
        if (!Directory.Exists(dir))
        {
            Directory.CreateDirectory(dir);
        }
        
        return Path.Combine(dir, "test-conversations.json");
    }

    /// <summary>
    /// Record a single-turn conversation test result.
    /// </summary>
    public static void RecordConversation(
        string testName,
        string userMessage,
        string? agentResponse,
        bool passed,
        string? errorMessage = null,
        TimeSpan? duration = null)
    {
        var conversation = new TestConversation
        {
            TestName = testName,
            Timestamp = DateTime.UtcNow,
            Duration = duration,
            Passed = passed,
            ErrorMessage = errorMessage,
            Turns = new List<ConversationTurn>
            {
                new()
                {
                    UserMessage = userMessage,
                    AgentResponse = agentResponse
                }
            }
        };

        AddConversation(conversation);
    }

    /// <summary>
    /// Record a multi-turn conversation test result.
    /// </summary>
    public static void RecordMultiTurnConversation(
        string testName,
        IEnumerable<(string UserMessage, string? AgentResponse)> turns,
        bool passed,
        string? errorMessage = null,
        TimeSpan? duration = null)
    {
        var conversation = new TestConversation
        {
            TestName = testName,
            Timestamp = DateTime.UtcNow,
            Duration = duration,
            Passed = passed,
            ErrorMessage = errorMessage,
            Turns = turns.Select(t => new ConversationTurn
            {
                UserMessage = t.UserMessage,
                AgentResponse = t.AgentResponse
            }).ToList()
        };

        AddConversation(conversation);
    }

    private static void AddConversation(TestConversation conversation)
    {
        lock (_lock)
        {
            // Load existing results on first use
            if (!_initialized)
            {
                LoadExisting();
                _initialized = true;
            }

            _conversations.Add(conversation);
            SaveToFile();
        }
    }

    private static void LoadExisting()
    {
        var path = GetOutputPath();
        if (File.Exists(path))
        {
            try
            {
                var json = File.ReadAllText(path);
                var results = JsonSerializer.Deserialize<TestResultsFile>(json);
                if (results?.Conversations != null)
                {
                    _conversations.AddRange(results.Conversations);
                }
            }
            catch
            {
                // Ignore errors loading existing file
            }
        }
    }

    private static void SaveToFile()
    {
        var path = GetOutputPath();
        var results = new TestResultsFile
        {
            GeneratedAt = DateTime.UtcNow,
            TotalTests = _conversations.Count,
            PassedTests = _conversations.Count(c => c.Passed),
            FailedTests = _conversations.Count(c => !c.Passed),
            Conversations = _conversations
        };

        var options = new JsonSerializerOptions
        {
            WriteIndented = true
        };

        var json = JsonSerializer.Serialize(results, options);
        File.WriteAllText(path, json);
    }
}

public class TestResultsFile
{
    public DateTime GeneratedAt { get; set; }
    public int TotalTests { get; set; }
    public int PassedTests { get; set; }
    public int FailedTests { get; set; }
    public List<TestConversation> Conversations { get; set; } = new();
}

public class TestConversation
{
    public string TestName { get; set; } = string.Empty;
    public DateTime Timestamp { get; set; }
    public TimeSpan? Duration { get; set; }
    public bool Passed { get; set; }
    public string? ErrorMessage { get; set; }
    public List<ConversationTurn> Turns { get; set; } = new();
}

public class ConversationTurn
{
    public string UserMessage { get; set; } = string.Empty;
    public string? AgentResponse { get; set; }
}
