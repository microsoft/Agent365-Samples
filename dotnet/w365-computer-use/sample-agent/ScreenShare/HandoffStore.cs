// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections.Concurrent;

namespace W365ComputerUseSample.ScreenShare;

/// <summary>
/// In-memory record bridging the chat link the agent posts to the browser
/// authenticated POST that exchanges the one-time handoff code (HC) for the ARI
/// bearer token. Single-process only — for multi-instance hosting, swap for a
/// distributed store (Redis, etc.).
/// </summary>
public sealed class HandoffRecord
{
    public required string ScreenShareUrl { get; init; }
    public required string OwnerAadObjectId { get; init; }
    public required byte[] HandoffCodeHash { get; init; }
    public required DateTime HandoffExpiresAtUtc { get; init; }
    public required string AriToken { get; init; }
    public required DateTime AriTokenExpiresAtUtc { get; init; }

    /// <summary>
    /// 0 = unburned, 1 = burned. Manipulated via <see cref="Interlocked.CompareExchange(ref int, int, int)"/>
    /// so two parallel valid requests cannot both succeed.
    /// </summary>
    public int Burned;
}

/// <summary>
/// Tracks per-session handoff records. Each record lives at most <c>HandoffExpiresAtUtc</c>
/// (5-minute HC TTL) — a background timer sweeps burned and expired entries every 60 seconds.
/// </summary>
public sealed class HandoffStore : IDisposable
{
    private readonly ConcurrentDictionary<string, HandoffRecord> _dict = new(StringComparer.Ordinal);
    private readonly Timer _cleanupTimer;

    public HandoffStore()
    {
        // Single timer, every 60 s, removes burned or HC-expired records.
        _cleanupTimer = new Timer(_ => Cleanup(), null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));
    }

    public void Set(string sid, HandoffRecord rec) => _dict[sid] = rec;

    public bool TryGet(string sid, out HandoffRecord? rec) => _dict.TryGetValue(sid, out rec);

    /// <summary>
    /// Atomic compare-and-swap: returns <c>true</c> exactly once per record. All
    /// subsequent callers (including races) see <c>false</c>.
    /// </summary>
    public bool TryBurn(string sid)
    {
        if (!_dict.TryGetValue(sid, out var rec)) return false;
        return Interlocked.CompareExchange(ref rec.Burned, 1, 0) == 0;
    }

    private void Cleanup()
    {
        var now = DateTime.UtcNow;
        foreach (var kvp in _dict)
        {
            if (kvp.Value.Burned == 1 || kvp.Value.HandoffExpiresAtUtc < now)
            {
                _dict.TryRemove(kvp.Key, out _);
            }
        }
    }

    public void Dispose() => _cleanupTimer.Dispose();
}
