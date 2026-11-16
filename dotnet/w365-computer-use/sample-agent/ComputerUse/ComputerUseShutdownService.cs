// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ComputerUse;

internal sealed class ComputerUseShutdownService(ComputerUseOrchestrator orchestrator) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) =>
        orchestrator.EndSessionOnShutdownAsync(cancellationToken);
}
