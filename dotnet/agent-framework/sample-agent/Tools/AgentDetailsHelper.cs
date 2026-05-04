// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;

namespace Agent365AgentFrameworkSampleAgent.Tools
{
    internal static class AgentDetailsHelper
    {
        internal static AgentDetails Build(IConfiguration configuration) =>
            new AgentDetails(
                agentId:          configuration["Agent365Observability:AgentId"]          ?? "local-dev",
                agentName:        configuration["Agent365Observability:AgentName"]        ?? "my-agent",
                agentDescription: configuration["Agent365Observability:AgentDescription"] ?? "",
                agentBlueprintId: configuration["Agent365Observability:AgentBlueprintId"] ?? "",
                tenantId:         configuration["Agent365Observability:TenantId"]         ?? "local-dev");
    }
}
