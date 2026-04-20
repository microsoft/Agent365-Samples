# Perplexity Sample Agent (.NET)

## Overview

A .NET sample showing how to use [Perplexity AI](https://docs.perplexity.ai/) as the LLM provider in an agent using the Microsoft Agent 365 SDK and Microsoft 365 Agents SDK.

It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- A [Perplexity API key](https://docs.perplexity.ai/)
- Microsoft Agent 365 SDK (`a365` CLI installed)

## Project Structure

```
sample-agent/
├── Agent/
│   └── MyAgent.cs              # AgentApplication — message/install handlers, MCP tool loading
├── telemetry/
│   ├── AgentMetrics.cs          # Custom ActivitySource, Meter, counters, histograms
│   ├── AgentOTELExtensions.cs   # OpenTelemetry builder configuration
│   └── A365OtelWrapper.cs       # BaggageBuilder + observability token cache wrapper
├── appPackage/
│   └── manifest.json            # Teams app manifest
├── AspNetExtensions.cs          # JWT bearer token validation
├── McpSession.cs                # JSON-RPC over Streamable HTTP client
├── McpToolService.cs            # MCP server discovery + tool registration
├── PerplexityClient.cs          # Perplexity Responses API client with tool-call loop
├── Program.cs                   # ASP.NET Core startup and DI
├── ToolingManifest.json         # MCP server definitions (Mail + Calendar)
├── appsettings.json             # Production configuration template
└── appsettings.Playground.json  # Playground/development configuration
```

## Architecture

- **Perplexity AI Integration**: Uses direct `HttpClient` against Perplexity's Responses API (`/v1/responses`) with function calling — no OpenAI SDK dependency.
- **Custom MCP Client**: `McpSession` speaks JSON-RPC over Streamable HTTP, handling initialization, tool discovery, and tool execution with Bearer + `X-Agent-Id` headers.
- **MCP Tool Service**: `McpToolService` discovers MCP servers via the A365 Tooling SDK (with `ToolingManifest.json` fallback), connects to each server, sanitizes tool schemas for Perplexity compatibility, and provides a tool executor with retry logic.
- **Multi-Turn Tool Loop**: `PerplexityClient` runs up to 8 rounds of tool calls within a 120-second wall-clock limit. Uses `tool_choice: "required"` on the first round for reliable tool invocation, argument enrichment via focused LLM calls, type coercion, and auto-finalize for create→send workflows.
- **Dual Auth Handlers**: Separate token scopes — `agentic` for Graph API identity and `mcp` for MCP server communication (A365 Tools API audience).

## Configuration

Set your Perplexity API key in `appsettings.json`:

```json
{
  "AIServices": {
    "Perplexity": {
      "Endpoint": "https://api.perplexity.ai/v1",
      "ApiKey": "your-api-key-here",
      "Model": "perplexity/sonar"
    }
  }
}
```

Or via environment variables: `PERPLEXITY_API_KEY`, `PERPLEXITY_MODEL`.

For Agent 365 service connection, run `a365 config init` and fill in:
- `TokenValidation:Audiences` — your app registration Client ID
- `Connections:ServiceConnection:Settings` — auth type and client credentials

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID |

The sample injects `Activity.From.Name` into the LLM system prompt for personalized responses.

## MCP Tools

The agent connects to MCP servers for Mail and Calendar tools:

| Server | Tools | Description |
|--------|-------|-------------|
| `mcp_MailTools` | Email send, search, read, reply, forward, etc. | Microsoft Graph Mail via MCP |
| `mcp_CalendarTools` | Event create, update, delete, list, etc. | Microsoft Graph Calendar via MCP |

## Sending Multiple Messages in Teams

The agent sends an immediate acknowledgment before the LLM response, plus a typing indicator loop:

```csharp
await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken);
await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken);
```

Each `SendActivityAsync` call produces a separate Teams message. The typing indicator refreshes every ~4 seconds during processing.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=dotnet) guide for complete instructions.

```bash
cd dotnet/perplexity/sample-agent
dotnet run
```

The agent starts on `http://localhost:3978` in development mode.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-dotnet/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - .NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Perplexity API documentation](https://docs.perplexity.ai/)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
