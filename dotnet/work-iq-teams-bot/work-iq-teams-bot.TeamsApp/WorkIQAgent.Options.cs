// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace work_iq_teams_bot.TeamsApp;

/// <summary>
/// Configuration options for the <see cref="WorkIQAgent"/>, including
/// the MCP server endpoints to connect to.
/// </summary>
internal sealed class WorkIQAgentOptions
{
    public const string SectionName = "WorkIQAgent";

    /// <summary>
    /// The MCP server URLs the agent connects to for tool discovery.
    /// </summary>
    public string[] McpServerUrls { get; set; } =
    [
        "https://agent365.svc.cloud.microsoft/agents/servers/mcp_TeamsServer",
        "https://agent365.svc.cloud.microsoft/agents/servers/mcp_MailTools",
        "https://agent365.svc.cloud.microsoft/agents/servers/mcp_CalendarTools",
        "https://agent365.svc.cloud.microsoft/agents/servers/mcp_MeServer",
    ];
}
