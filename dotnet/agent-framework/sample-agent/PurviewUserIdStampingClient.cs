// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Extensions.AI;

namespace Agent365AgentFrameworkSampleAgent;

/// <summary>
/// A delegating <see cref="IChatClient"/> that stamps each user message with a
/// Purview userId before forwarding the call to the inner client.
/// This is required when authenticating to Purview with app-level credentials
/// (e.g. ClientSecretCredential) since the userId cannot be inferred from the token.
/// </summary>
internal sealed class PurviewUserIdStampingClient(IChatClient innerClient, string userId)
    : DelegatingChatClient(innerClient)
{
    private const string UserIdKey = "userId";

    public override Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        StampMessages(messages);
        return base.GetResponseAsync(messages, options, cancellationToken);
    }

    public override IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        StampMessages(messages);
        return base.GetStreamingResponseAsync(messages, options, cancellationToken);
    }

    private void StampMessages(IEnumerable<ChatMessage> messages)
    {
        foreach (var message in messages)
        {
            if (message.Role == ChatRole.User)
            {
                message.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                if (!message.AdditionalProperties.ContainsKey(UserIdKey))
                {
                    message.AdditionalProperties[UserIdKey] = userId;
                }
            }
        }
    }
}
