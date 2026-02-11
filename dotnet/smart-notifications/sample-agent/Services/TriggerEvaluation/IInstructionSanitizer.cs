// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation;

/// <summary>
/// Sanitizes instructions to prevent prompt injection attacks.
/// Extracted to support Open/Closed Principle - can be extended or replaced.
/// </summary>
public interface IInstructionSanitizer
{
    /// <summary>
    /// Sanitizes an instruction string.
    /// </summary>
    /// <param name="instruction">The instruction to sanitize.</param>
    /// <returns>The sanitized instruction, or empty string if completely filtered.</returns>
    string Sanitize(string instruction);

    /// <summary>
    /// Sanitizes multiple instructions.
    /// </summary>
    /// <param name="instructions">The instructions to sanitize.</param>
    /// <returns>Sanitized instructions with empty ones filtered out.</returns>
    IEnumerable<string> SanitizeAll(IEnumerable<string> instructions);
}

/// <summary>
/// Default implementation of instruction sanitizer with configurable patterns.
/// Supports Open/Closed Principle - patterns can be configured without modifying class.
/// </summary>
public sealed class DefaultInstructionSanitizer : IInstructionSanitizer
{
    private readonly TriggerEvaluationOptions _options;
    private readonly IReadOnlyList<string> _suspiciousPatterns;

    /// <summary>
    /// Default patterns that might indicate prompt injection attempts.
    /// </summary>
    public static readonly IReadOnlyList<string> DefaultSuspiciousPatterns = new[]
    {
        "SYSTEM:",
        "IGNORE PREVIOUS",
        "IGNORE ALL",
        "DISREGARD",
        "FORGET EVERYTHING",
        "NEW INSTRUCTIONS:",
        "OVERRIDE:",
        "```system",
        "<system>",
        "</system>",
        "ASSISTANT:",
        "USER:",
        "Human:",
        "Assistant:"
    };

    /// <summary>
    /// Initializes a new instance with default patterns.
    /// </summary>
    /// <param name="options">The trigger evaluation options.</param>
    public DefaultInstructionSanitizer(TriggerEvaluationOptions options)
        : this(options, DefaultSuspiciousPatterns)
    {
    }

    /// <summary>
    /// Initializes a new instance with custom patterns.
    /// Supports Open/Closed Principle - extend patterns without modifying class.
    /// </summary>
    /// <param name="options">The trigger evaluation options.</param>
    /// <param name="suspiciousPatterns">Custom patterns to filter.</param>
    public DefaultInstructionSanitizer(
        TriggerEvaluationOptions options,
        IReadOnlyList<string> suspiciousPatterns)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _suspiciousPatterns = suspiciousPatterns ?? throw new ArgumentNullException(nameof(suspiciousPatterns));
    }

    /// <inheritdoc/>
    public string Sanitize(string instruction)
    {
        if (string.IsNullOrWhiteSpace(instruction))
        {
            return string.Empty;
        }

        // Truncate overly long instructions
        var sanitized = instruction.Length > _options.MaxInstructionLength
            ? instruction[.._options.MaxInstructionLength]
            : instruction;

        // Remove suspicious patterns
        foreach (var pattern in _suspiciousPatterns)
        {
            if (sanitized.Contains(pattern, StringComparison.OrdinalIgnoreCase))
            {
                sanitized = Regex.Replace(
                    sanitized,
                    Regex.Escape(pattern),
                    "[FILTERED]",
                    RegexOptions.IgnoreCase);
            }
        }

        // Remove XML/HTML-like tags
        sanitized = Regex.Replace(sanitized, @"<[^>]+>", "[TAG]");

        return sanitized.Trim();
    }

    /// <inheritdoc/>
    public IEnumerable<string> SanitizeAll(IEnumerable<string> instructions)
    {
        if (instructions == null)
        {
            yield break;
        }

        var count = 0;
        foreach (var instruction in instructions)
        {
            if (count >= _options.MaxInstructions)
            {
                yield break;
            }

            var sanitized = Sanitize(instruction);
            if (!string.IsNullOrWhiteSpace(sanitized))
            {
                count++;
                yield return sanitized;
            }
        }
    }
}
