// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace Agent365SemanticKernelSampleAgent.Constants;

/// <summary>
/// Constants used throughout the Agent365 application.
/// </summary>
public static class Agent365Constants
{
    /// <summary>
    /// The directory name for the A365 CLI cache in the local application data folder.
    /// </summary>
    public const string A365CliCacheDirectory = "Microsoft.Agents.A365.DevTools.Cli";

    /// <summary>
    /// The file name for the cached MCP bearer token.
    /// </summary>
    public const string McpBearerTokenFileName = "mcp_bearer_token.json";
}
