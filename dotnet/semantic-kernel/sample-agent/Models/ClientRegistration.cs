// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;

namespace Agent365SemanticKernelSampleAgent.Models;

/// <summary>
/// Represents a registered WNS client
/// </summary>
public class ClientRegistration
{
    public string ClientName { get; set; } = string.Empty;
    public string ChannelUri { get; set; } = string.Empty;
    public string MachineName { get; set; } = string.Empty;
    public DateTime RegisteredAt { get; set; }
    public DateTime LastSeen { get; set; }
}

/// <summary>
/// Request model for registering a new WNS client
/// </summary>
public class ChannelRegistrationRequest
{
    public string ClientName { get; set; } = string.Empty;
    public string ChannelUri { get; set; } = string.Empty;
    public string MachineName { get; set; } = string.Empty;
    public DateTime RegisteredAt { get; set; }
}
