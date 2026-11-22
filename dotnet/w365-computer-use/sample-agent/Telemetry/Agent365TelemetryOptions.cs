// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.Telemetry;

public sealed class Agent365TelemetryOptions
{
    public const string SectionName = "Agent365Observability";

    public string? AgentId { get; init; }

    public string? AgentName { get; init; }

    public string? AgentDescription { get; init; }

    public string? TenantId { get; init; }

    public string? AgentBlueprintId { get; init; }

    public string? ClientId { get; init; }

    public string? AgenticUserId { get; init; }

    public string? AgenticUserEmail { get; init; }

    public string? MessagingEndpoint { get; init; }

    public string DefaultChannelName { get; init; } = "msteams";

    public string OperationSource { get; init; } = "W365ComputerUseSample";
}
