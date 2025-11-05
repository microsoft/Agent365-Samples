// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.ComponentModel;
using System.Text.Json.Serialization;

namespace Agent365SemanticKernelSampleAgent.Agents;

public enum Agent365AgentResponseContentType
{
    [JsonPropertyName("text")]
    Text
}

public class Agent365AgentResponse
{
    [JsonPropertyName("contentType")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public Agent365AgentResponseContentType ContentType { get; set; }

    [JsonPropertyName("content")]
    [Description("The content of the response. May only be plain text.")]
    public string? Content { get; set; }
}
