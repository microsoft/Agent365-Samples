// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using System.ComponentModel;

namespace Agent365AgentFrameworkSampleAgent.Tools
{
    public class DateTimeFunctionTool(IConfiguration configuration)
    {
        [Description("Use this tool to get the current date and time")]
        public string GetCurrentDateTime()
        {
            var toolCallDetails = new ToolCallDetails(
                toolName: nameof(GetCurrentDateTime),
                arguments: "{}",
                toolCallId: Guid.NewGuid().ToString(),
                description: "Returns the current date and time",
                toolType: "function",
                endpoint: new Uri("local://datetime")
            );
            using var toolScope = ExecuteToolScope.Start(
                request: new Request("Get current date and time"),
                details: toolCallDetails,
                agentDetails: AgentDetailsHelper.Build(configuration));

            string date = DateTimeOffset.Now.ToString("D", null);
            toolScope.RecordResponse(date);
            return date;
        }

    }
}
