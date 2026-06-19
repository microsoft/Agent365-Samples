// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Extensions.AI;
using System.Collections.Concurrent;

namespace work_iq_teams_bot.TeamsApp;

/// <summary>
/// Stores per-conversation chat history and provides a serialization gate so
/// concurrent turns within the same conversation cannot interleave history mutations.
/// Implementations are expected to be registered as a singleton, since per-conversation
/// state must outlive any individual turn.
/// </summary>
internal interface IConversationHistoryStore
{
    /// <summary>
    /// Returns the conversation's chat history, creating it from <paramref name="seed"/> on first access.
    /// </summary>
    /// <param name="conversationId">The conversation identifier.</param>
    /// <param name="seed">Initial messages (typically a system prompt) used only on first access.</param>
    List<ChatMessage> GetOrCreateHistory(string conversationId, Func<IEnumerable<ChatMessage>> seed);

    /// <summary>
    /// Acquires the per-conversation serialization gate. Dispose the returned handle to release.
    /// </summary>
    Task<IAsyncDisposable> AcquireGateAsync(string conversationId, CancellationToken cancellationToken);
}

/// <summary>
/// Process-local <see cref="IConversationHistoryStore"/> backed by <see cref="ConcurrentDictionary{TKey, TValue}"/>.
/// History grows unbounded for the lifetime of the process; replace with a distributed/bounded store for production.
/// </summary>
internal sealed class InMemoryConversationHistoryStore : IConversationHistoryStore
{
    private readonly ConcurrentDictionary<string, List<ChatMessage>> _histories = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    public List<ChatMessage> GetOrCreateHistory(string conversationId, Func<IEnumerable<ChatMessage>> seed)
    {
        ArgumentException.ThrowIfNullOrEmpty(conversationId);
        ArgumentNullException.ThrowIfNull(seed);

        return _histories.GetOrAdd(conversationId, _ => [.. seed()]);
    }

    public async Task<IAsyncDisposable> AcquireGateAsync(string conversationId, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(conversationId);

        SemaphoreSlim gate = _locks.GetOrAdd(conversationId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        return new GateHandle(gate);
    }

    private sealed class GateHandle(SemaphoreSlim gate) : IAsyncDisposable
    {
        private int _released;

        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                gate.Release();
            }
            return ValueTask.CompletedTask;
        }
    }
}
