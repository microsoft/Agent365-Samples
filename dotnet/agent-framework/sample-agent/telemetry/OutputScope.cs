// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using System.Diagnostics;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    /// <summary>
    /// Provides OpenTelemetry tracing scope for agent output operations.
    /// This scope is used to trace outbound messages from an agent.
    /// </summary>
    /// <remarks>
    /// This is a local implementation until OutputScope is available in the Observability.Runtime package.
    /// </remarks>
    public sealed class OutputScope : OpenTelemetryScope
    {
        /// <summary>
        /// The operation name for agent output tracing.
        /// </summary>
        public const string OperationName = "agent_output";

        /// <summary>
        /// Creates and starts a new scope for agent output tracing.
        /// </summary>
        /// <param name="agentDetails">The details of the agent producing the output.</param>
        /// <param name="tenantDetails">The tenant details for the agent output.</param>
        /// <param name="outputMessages">The output messages being sent.</param>
        /// <param name="parentId">Optional parent span ID for trace correlation.</param>
        /// <param name="conversationId">Optional conversation ID for the output.</param>
        /// <returns>A new OutputScope instance.</returns>
        public static OutputScope Start(
            AgentDetails agentDetails,
            TenantDetails tenantDetails,
            string[]? outputMessages = null,
            string? parentId = null,
            string? conversationId = null)
            => new OutputScope(agentDetails, tenantDetails, outputMessages, parentId, conversationId);

        private OutputScope(
            AgentDetails agentDetails,
            TenantDetails tenantDetails,
            string[]? outputMessages,
            string? parentId,
            string? conversationId)
            : base(
                kind: ActivityKind.Producer,
                agentDetails: agentDetails,
                tenantDetails: tenantDetails,
                operationName: OperationName,
                activityName: string.IsNullOrWhiteSpace(agentDetails.AgentName)
                    ? OperationName
                    : $"{OperationName} {agentDetails.AgentName}",
                parentId: parentId,
                conversationId: conversationId)
        {
            // Record output messages if provided
            if (outputMessages != null && outputMessages.Length > 0)
            {
                RecordOutputMessages(outputMessages);
            }
        }

        /// <summary>
        /// Records the output messages for telemetry tracking.
        /// </summary>
        /// <param name="messages">The output messages to record.</param>
        public void RecordOutputMessages(string[] messages)
        {
            SetTagMaybe(OpenTelemetryConstants.GenAiOutputMessagesKey, string.Join(",", messages));
        }
    }
}
