// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Collections.Generic;
using System.Linq;
using Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation;
using Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation.Models;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel.ChatCompletion;

namespace Agent365TaskPersonalizationSampleAgent.Extensions;

/// <summary>
/// Extension methods for ChatHistory to support trigger instruction handling.
///
/// Design Principles:
/// - SRP: Focused on ChatHistory manipulation only
/// - OCP: Sanitization delegated to IInstructionSanitizer (configurable)
/// - DIP: Depends on abstractions, not concretions
/// </summary>
public static class ChatHistoryExtensions
{
    private const string TriggerInstructionsAddedKey = "conversation.triggerInstructionsAdded";
    private const string TaskInstructionsMarker = "TASK INSTRUCTIONS:";

    /// <summary>
    /// Applies trigger instructions to the chat history using the provided sanitizer.
    /// Prevents duplicate instructions by:
    /// 1. Checking turnState for a flag (persists across turns in the same conversation)
    /// 2. Checking if instructions already exist in chat history
    /// </summary>
    /// <param name="chatHistory">The chat history to add instructions to.</param>
    /// <param name="response">The trigger evaluation response containing instructions.</param>
    /// <param name="turnContext">The turn context.</param>
    /// <param name="turnState">The turn state for tracking if instructions were already added (persists across turns).</param>
    /// <param name="sanitizer">The instruction sanitizer to use.</param>
    /// <param name="logger">Optional logger for tracking when instructions are applied.</param>
    /// <param name="contextInfo">Optional context information for logging.</param>
    /// <returns>True if trigger instructions were applied, false otherwise.</returns>
    public static bool ApplyTriggerInstructions(
        this ChatHistory chatHistory,
        TriggerEvaluationResponse? response,
        ITurnContext turnContext,
        ITurnState turnState,
        IInstructionSanitizer sanitizer,
        ILogger? logger = null,
        string? contextInfo = null)
    {
        ArgumentNullException.ThrowIfNull(turnContext);
        ArgumentNullException.ThrowIfNull(turnState);
        ArgumentNullException.ThrowIfNull(sanitizer);

        if (response == null || !response.IsActive || !response.HasInstructions)
        {
            return false;
        }

        // Check 1: Turn state flag (persists across turns in the same conversation)
        var instructionsAdded = turnState.GetValue<bool>(TriggerInstructionsAddedKey);
        if (instructionsAdded)
        {
            logger?.LogDebug("Trigger instructions already added to this conversation (turn state), skipping");
            return false;
        }

        // Check 2: Look for existing instructions in chat history
        if (HasExistingInstructions(chatHistory))
        {
            logger?.LogDebug("Trigger instructions already exist in chat history, skipping");
            // Mark turn state so we don't check again
            turnState.SetValue(TriggerInstructionsAddedKey, true);
            return false;
        }

        var sanitizedInstructions = sanitizer.SanitizeAll(response.Instructions).ToList();

        if (sanitizedInstructions.Count == 0)
        {
            logger?.LogWarning("All trigger instructions were filtered out during sanitization");
            return false;
        }

        var systemMessage = BuildInstructionMessage(sanitizedInstructions);
        chatHistory.AddSystemMessage(systemMessage);

        // Mark that we've added instructions to this conversation
        turnState.SetValue(TriggerInstructionsAddedKey, true);

        LogInstructionsApplied(logger, response.Instructions.Length, sanitizedInstructions.Count, contextInfo);

        return true;
    }

    /// <summary>
    /// Applies trigger instructions to the chat history.
    /// Uses default sanitizer.
    /// </summary>
    public static bool ApplyTriggerInstructions(
        this ChatHistory chatHistory,
        TriggerEvaluationResponse? response,
        ITurnContext turnContext,
        ITurnState turnState,
        ILogger? logger = null,
        string? contextInfo = null)
    {
        var options = new TriggerEvaluationOptions();
        var sanitizer = new DefaultInstructionSanitizer(options);

        return ApplyTriggerInstructions(chatHistory, response, turnContext, turnState, sanitizer, logger, contextInfo);
    }

    /// <summary>
    /// Applies trigger instructions to the chat history (simplified overload).
    /// Uses turnContext.Services for within-turn duplicate prevention only.
    /// For multi-turn conversations, prefer the overload with ITurnState.
    /// </summary>
    public static bool ApplyTriggerInstructions(
        this ChatHistory chatHistory,
        TriggerEvaluationResponse? response,
        ITurnContext turnContext,
        ILogger? logger = null,
        string? contextInfo = null)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        if (response == null || !response.IsActive || !response.HasInstructions)
        {
            return false;
        }

        // Check for existing instructions in chat history
        if (HasExistingInstructions(chatHistory))
        {
            logger?.LogDebug("Trigger instructions already exist in chat history, skipping");
            return false;
        }

        var options = new TriggerEvaluationOptions();
        var sanitizer = new DefaultInstructionSanitizer(options);
        var sanitizedInstructions = sanitizer.SanitizeAll(response.Instructions).ToList();

        if (sanitizedInstructions.Count == 0)
        {
            logger?.LogWarning("All trigger instructions were filtered out during sanitization");
            return false;
        }

        var systemMessage = BuildInstructionMessage(sanitizedInstructions);
        chatHistory.AddSystemMessage(systemMessage);

        LogInstructionsApplied(logger, response.Instructions.Length, sanitizedInstructions.Count, contextInfo);

        return true;
    }

    /// <summary>
    /// Checks if the chat history already contains task instructions.
    /// </summary>
    private static bool HasExistingInstructions(ChatHistory chatHistory)
    {
        foreach (var message in chatHistory)
        {
            if (message.Role == AuthorRole.System &&
                message.Content?.Contains(TaskInstructionsMarker, StringComparison.Ordinal) == true)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Adds context information from the activity to the chat history.
    /// Includes channel, sender, recipient, timestamp, and conversation type information.
    /// </summary>
    /// <param name="chatHistory">The chat history to add context to.</param>
    /// <param name="activity">The activity containing context information.</param>
    /// <param name="logger">Optional logger for tracking when context is added.</param>
    public static void AddActivityContext(
        this ChatHistory chatHistory,
        IActivity activity,
        ILogger? logger = null)
    {
        if (activity == null)
        {
            return;
        }

        var contextParts = new List<string>();

        AddChannelContext(activity, contextParts);
        AddSenderContext(activity, contextParts);
        AddRecipientContext(activity, contextParts);
        AddTimestampContext(activity, contextParts);

        if (contextParts.Count > 0)
        {
            var contextMessage = $"[Message Context: {string.Join(" | ", contextParts)}]";
            chatHistory.AddSystemMessage(contextMessage);

            logger?.LogDebug("Added activity context to chat history: {Context}", contextMessage);
        }
    }

    #region Private Helpers

    private static string BuildInstructionMessage(IReadOnlyList<string> instructions)
    {
        return $"""
            TASK INSTRUCTIONS:
            {string.Join("\n", instructions.Select((instr, i) => $"{i + 1}. {instr}"))}

            Execute all instructions above. This may include responding to the user AND/OR taking other actions (sending emails, creating tasks, notifying others, etc.).
            """;
    }

    private static void LogInstructionsApplied(
        ILogger? logger,
        int originalCount,
        int appliedCount,
        string? contextInfo)
    {
        if (logger == null) return;

        var filteredCount = originalCount - appliedCount;
        if (filteredCount > 0)
        {
            logger.LogInformation(
                "Filtered {FilteredCount} instructions during sanitization",
                filteredCount);
        }

        if (!string.IsNullOrEmpty(contextInfo))
        {
            logger.LogInformation(
                "Applied {Count} trigger instructions to agent context for {Context}",
                appliedCount,
                contextInfo);
        }
        else
        {
            logger.LogInformation(
                "Applied {Count} trigger instructions to agent context",
                appliedCount);
        }
    }

    private static void AddChannelContext(IActivity activity, List<string> contextParts)
    {
        if (activity.ChannelId != null)
        {
            contextParts.Add($"Channel: {activity.ChannelId.Channel ?? "unknown"}");
        }

        if (activity.Conversation?.ConversationType != null)
        {
            contextParts.Add($"Conversation Type: {activity.Conversation.ConversationType}");
        }
    }

    private static void AddSenderContext(IActivity activity, List<string> contextParts)
    {
        if (activity.From == null) return;

        var senderName = SanitizeContextValue(activity.From.Name);
        var senderId = activity.From.AadObjectId ?? activity.From.Id ?? "unknown";
        var senderInfo = !string.IsNullOrEmpty(senderName)
            ? $"{senderName} ({senderId})"
            : senderId;
        contextParts.Add($"From: {senderInfo}");
    }

    private static void AddRecipientContext(IActivity activity, List<string> contextParts)
    {
        if (activity.Recipient != null && !string.IsNullOrEmpty(activity.Recipient.Name))
        {
            contextParts.Add($"To: {SanitizeContextValue(activity.Recipient.Name)}");
        }
    }

    private static void AddTimestampContext(IActivity activity, List<string> contextParts)
    {
        if (activity.Timestamp.HasValue)
        {
            contextParts.Add($"Timestamp: {activity.Timestamp.Value:yyyy-MM-dd HH:mm:ss UTC}");
        }

        if (!string.IsNullOrEmpty(activity.Locale))
        {
            contextParts.Add($"Locale: {activity.Locale}");
        }
    }

    /// <summary>
    /// Sanitizes a context value to prevent log/prompt injection.
    /// </summary>
    private static string SanitizeContextValue(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        return value
            .Replace("\n", " ")
            .Replace("\r", " ")
            .Replace("|", "-")
            [..Math.Min(value.Length, 100)];
    }

    #endregion
}
