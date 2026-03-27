// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;
using System.Text.Json.Serialization;

namespace W365ComputerUseSample.ComputerUse.Models;

/// <summary>
/// Response from the OpenAI Computer Use API.
/// </summary>
public class ComputerUseResponse
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("object")]
    public string? Object { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("output")]
    public List<JsonElement>? Output { get; set; }
}

/// <summary>
/// Request to the OpenAI Computer Use API.
/// </summary>
public class ComputerUseRequest
{
    [JsonPropertyName("model")]
    public string Model { get; set; } = "computer-use-preview-2025-03-11";

    [JsonPropertyName("truncation")]
    public string Truncation { get; set; } = "auto";

    [JsonPropertyName("instructions")]
    public string? Instructions { get; set; }

    [JsonPropertyName("input")]
    public List<JsonElement> Input { get; set; } = [];

    [JsonPropertyName("tools")]
    public List<object> Tools { get; set; } = [];
}

/// <summary>
/// Defines the computer_use_preview tool for the OpenAI Responses API.
/// </summary>
public class ComputerUseTool
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "computer_use_preview";

    [JsonPropertyName("display_width")]
    public int DisplayWidth { get; set; } = 1024;

    [JsonPropertyName("display_height")]
    public int DisplayHeight { get; set; } = 768;

    [JsonPropertyName("environment")]
    public string Environment { get; set; } = "windows";
}

/// <summary>
/// Defines a function tool for the OpenAI Responses API.
/// </summary>
public class FunctionToolDefinition
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "function";

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("parameters")]
    public object? Parameters { get; set; }
}
