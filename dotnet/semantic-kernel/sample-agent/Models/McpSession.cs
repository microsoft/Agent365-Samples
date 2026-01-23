// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Models;

/// <summary>
/// Represents an MCP session with WebSocket connection tracking
/// </summary>
public class McpSession
{
    public string SessionId { get; set; } = string.Empty;
    public WebSocket? WebSocket { get; set; }
    public DateTime Created { get; set; } = DateTime.UtcNow;
    public DateTime LastActivity { get; set; } = DateTime.UtcNow;
    public bool IsConnected => WebSocket?.State == WebSocketState.Open;

    /// <summary>
    /// For handling request/response correlation
    /// </summary>
    public System.Collections.Concurrent.ConcurrentDictionary<int, TaskCompletionSource<string>> PendingRequests { get; } = new();

    public void UpdateActivity()
    {
        LastActivity = DateTime.UtcNow;
    }
}
