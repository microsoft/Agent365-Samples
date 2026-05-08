# Perplexity Sample Agent Design

## Overview

This sample demonstrates a Perplexity AI-powered agent built using the Microsoft Agents SDK with direct HTTP integration. It showcases the core patterns for building production-ready agents with live web search, MCP server integration, and Microsoft Agent 365 observability.

## What This Sample Demonstrates

- Perplexity AI integration via the OpenAI-compatible Responses API
- Live web search capabilities through Perplexity's Sonar models
- MCP server tool registration and invocation (Mail, Calendar)
- Multi-turn function calling with automatic tool loop
- Dual authentication (agentic and OBO handlers)
- Microsoft Agent 365 observability integration

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Program.cs                                │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ OpenTelemetry│  │ A365 Tracing│  │ ASP.NET Authentication │ │
│  └─────────────┘  └─────────────┘  └──────────────────────────┘ │
│                           │                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Dependency Injection Container                  ││
│  │  ┌───────────────┐ ┌───────────┐ ┌──────────┐              ││
│  │  │IMcpToolRegSvc │ │IStorage   │ │ITokenCache│              ││
│  │  └───────────────┘ └───────────┘ └──────────┘              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MyAgent                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Event Handlers                            ││
│  │  ┌────────────────┐  ┌────────────────┐                     ││
│  │  │MembersAdded    │  │Message (Agentic│                     ││
│  │  │→ Welcome       │  │& Non-Agentic)  │                     ││
│  │  └────────────────┘  └────────────────┘                     ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  PerplexityClient                            ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      ││
│  │  │HttpClient    │  │Tool Loop     │  │Arg Enrichment│      ││
│  │  │(Responses API)│  │(8 rounds max)│  │& Auto-finalize│     ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  McpToolService                             ││
│  │  ┌──────────────┐  ┌──────────────┐                         ││
│  │  │Mail MCP      │  │Calendar MCP  │                         ││
│  │  └──────────────┘  └──────────────┘                         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Differences from Agent Framework Sample

| Aspect | Agent Framework Sample | Perplexity Sample |
|--------|----------------------|-------------------|
| AI Backend | Azure OpenAI via IChatClient | Perplexity AI via HttpClient |
| Tool Integration | Agent Framework extensions | Custom MCP via McpSession |
| Response Mode | Streaming (RunStreamingAsync) | Request-response (InvokeAsync) |
| Local Tools | Weather, DateTime | None (MCP tools only) |
| Conversation | Thread-managed (AgentThread) | Stateless per-turn |
| Tool Definitions | AITool / AIFunctionFactory | JsonElement (Responses API format) |

## File Structure

```
sample-agent/
├── Agent/
│   └── MyAgent.cs              # Main agent — message handling, auth, typing
├── appPackage/
│   ├── manifest.json           # Teams app manifest
│   ├── color.png               # App icon (color)
│   └── outline.png             # App icon (outline)
├── docs/
│   └── design.md               # This file
├── telemetry/
│   ├── AgentMetrics.cs         # OpenTelemetry metrics & activities
│   ├── AgentOTELExtensions.cs  # OTEL configuration
│   └── A365OtelWrapper.cs      # A365 observability wrapper
├── .gitignore
├── appsettings.json            # Production config template
├── appsettings.Playground.json # Local dev config
├── AspNetExtensions.cs         # JWT auth middleware
├── McpSession.cs               # Lightweight MCP JSON-RPC client
├── McpToolService.cs          # MCP server discovery, tool registration, and invocation
├── PerplexityClient.cs         # Perplexity Responses API client
├── PerplexitySampleAgent.csproj # Project file
├── Program.cs                  # ASP.NET Core startup
├── README.md                   # Getting started guide
└── ToolingManifest.json        # MCP server configuration
```

## PerplexityClient Design

The `PerplexityClient` uses `HttpClient` directly to call the Perplexity Responses API at `https://api.perplexity.ai/v1/responses`. This approach was chosen over using the OpenAI .NET SDK because:

1. The OpenAI SDK's Responses API types are experimental (OPENAI001)
2. Direct HTTP gives full control over request/response handling
3. Closer alignment to how the Python reference sample works

### Tool Loop

The client supports multi-turn function calling:
- Max 8 tool-call rounds per invocation
- 120-second wall-clock limit
- 90-second per-round timeout
- Nudge retry when model describes instead of calling tools
- Auto-finalize for create→send workflows (e.g., draft created but not sent)
- Argument enrichment from user message context
