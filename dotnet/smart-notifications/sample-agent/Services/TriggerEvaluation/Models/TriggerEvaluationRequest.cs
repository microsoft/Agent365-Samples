// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Text.Json.Serialization;

namespace Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation.Models;

/// <summary>
/// Request model for trigger evaluation API.
/// </summary>
public sealed class TriggerEvaluationRequest
{
    /// <summary>
    /// Gets or sets the agent ID for filtering triggers.
    /// </summary>
    [JsonPropertyName("agentId")]
    public required string AgentId { get; set; }

    /// <summary>
    /// Gets or sets the event type (email, document, message).
    /// </summary>
    [JsonPropertyName("eventType")]
    public required string EventType { get; set; }

    /// <summary>
    /// Gets or sets the event data to evaluate against trigger conditions.
    /// </summary>
    [JsonPropertyName("eventData")]
    public required object EventData { get; set; }
}

/// <summary>
/// Response model from trigger evaluation API.
/// </summary>
public sealed class TriggerEvaluationResponse
{
    /// <summary>
    /// Gets an empty response indicating no triggers matched.
    /// Returns a new instance each time to prevent shared state mutation.
    /// </summary>
    public static TriggerEvaluationResponse Empty => new()
    {
        IsActive = false,
        MatchedTriggerCount = 0,
        Instructions = []
    };

    /// <summary>
    /// Gets or sets a value indicating whether any triggers matched.
    /// </summary>
    [JsonPropertyName("isActive")]
    public bool IsActive { get; init; }

    /// <summary>
    /// Gets or sets the number of trigger definitions that matched the event.
    /// </summary>
    [JsonPropertyName("matchedTriggerCount")]
    public int MatchedTriggerCount { get; init; }

    /// <summary>
    /// Gets or sets the instructions from matching triggers.
    /// </summary>
    [JsonPropertyName("instructions")]
    public string[] Instructions { get; init; } = [];

    /// <summary>
    /// Gets a value indicating whether there are any instructions.
    /// </summary>
    [JsonIgnore]
    public bool HasInstructions => Instructions.Length > 0;

    /// <summary>
    /// Gets the combined instructions as a single string.
    /// </summary>
    /// <param name="separator">The separator to use between instructions.</param>
    /// <returns>Combined instructions string, or empty if no instructions.</returns>
    public string GetCombinedInstructions(string separator = "\n\n")
    {
        return HasInstructions ? string.Join(separator, Instructions) : string.Empty;
    }
}
