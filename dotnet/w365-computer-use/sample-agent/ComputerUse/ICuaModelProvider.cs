// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Abstraction for sending requests to a CUA-capable model (OpenAI Responses API).
/// Implementations handle authentication and endpoint differences.
/// </summary>
public interface ICuaModelProvider
{
    /// <summary>The model name to include in the request body.</summary>
    string ModelName { get; }

    /// <summary>Send a serialized request body and return the raw JSON response.</summary>
    Task<string> SendAsync(string requestBody, CancellationToken cancellationToken);
}
