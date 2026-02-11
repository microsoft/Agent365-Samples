// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

namespace Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation;

/// <summary>
/// Configuration options for trigger evaluation services.
/// Use the Options pattern for clean configuration management.
/// </summary>
public sealed class TriggerEvaluationOptions
{
    /// <summary>
    /// Configuration section name for binding.
    /// </summary>
    public const string SectionName = "TriggerEvaluation";

    /// <summary>
    /// Gets or sets the MCP Platform base URL.
    /// </summary>
    public string? McpPlatformBaseUrl { get; set; }

    /// <summary>
    /// Gets or sets the maximum payload size in bytes for trigger evaluation requests.
    /// Default is 1MB.
    /// </summary>
    public int MaxPayloadSizeBytes { get; set; } = 1_000_000;

    /// <summary>
    /// Gets or sets the maximum length for a single instruction.
    /// Used for both validation and sanitization.
    /// </summary>
    public int MaxInstructionLength { get; set; } = 2000;

    /// <summary>
    /// Gets or sets the maximum number of instructions to process.
    /// </summary>
    public int MaxInstructions { get; set; } = 10;

    /// <summary>
    /// Gets or sets the request timeout in seconds.
    /// Default is 30 seconds.
    /// </summary>
    public int RequestTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Gets or sets the maximum retry attempts for transient failures.
    /// Default is 3.
    /// </summary>
    public int MaxRetryAttempts { get; set; } = 3;
}
