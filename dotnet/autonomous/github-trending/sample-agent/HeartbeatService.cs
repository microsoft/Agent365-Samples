// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace GitHubTrending;

/// <summary>
/// Background service that logs a heartbeat message on a configurable interval.
/// Interval is controlled by HeartbeatIntervalMs in configuration (default: 60 000 ms).
/// </summary>
internal sealed class HeartbeatService : BackgroundService
{
    private readonly ILogger<HeartbeatService> _logger;
    private readonly TimeSpan _interval;

    public HeartbeatService(ILogger<HeartbeatService> logger, IConfiguration configuration)
    {
        _logger = logger;

        var intervalMs = configuration.GetValue<int>("HeartbeatIntervalMs", 60_000);
        _interval = TimeSpan.FromMilliseconds(intervalMs);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("HeartbeatService started. Interval: {Interval}", _interval);

        using var timer = new PeriodicTimer(_interval);

        while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
        {
            _logger.LogInformation("Agent heartbeat {Timestamp}", DateTimeOffset.UtcNow);
        }

        _logger.LogInformation("HeartbeatService stopped.");
    }
}
