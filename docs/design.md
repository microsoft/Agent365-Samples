# Agent365-Samples Design Document

## Overview

This repository contains sample agents for the Microsoft Agent 365 SDK, demonstrating how to build production-ready agents across multiple programming languages and AI orchestrators. The samples showcase enterprise-grade capabilities including observability, authentication, MCP (Model Context Protocol) tooling, and notification handling.

## Repository Structure

```
Agent365-Samples/
├── docs/                          # Repository-wide documentation
│   └── design.md                  # This document
├── dotnet/                        # C# / .NET samples
│   ├── docs/design.md            # .NET design guidelines
│   ├── agent-framework/          # Agent Framework orchestrator
│   └── semantic-kernel/          # Semantic Kernel orchestrator
├── python/                        # Python samples
│   ├── docs/design.md            # Python design guidelines
│   ├── agent-framework/          # Agent Framework orchestrator
│   ├── claude/                   # Anthropic Claude orchestrator
│   ├── crewai/                   # CrewAI orchestrator
│   ├── google-adk/               # Google ADK orchestrator
│   └── openai/                   # OpenAI Agents SDK orchestrator
├── nodejs/                        # Node.js / TypeScript samples
│   ├── docs/design.md            # Node.js design guidelines
│   ├── claude/                   # Anthropic Claude orchestrator
│   ├── devin/                    # Devin orchestrator
│   ├── langchain/                # LangChain orchestrator
│   ├── n8n/                      # N8N orchestrator
│   ├── openai/                   # OpenAI Agents SDK orchestrator
│   ├── perplexity/               # Perplexity orchestrator
│   └── vercel-sdk/               # Vercel AI SDK orchestrator
└── prompts/                       # AI development prompts
```

## Cross-Cutting Architectural Patterns

All sample agents in this repository follow consistent architectural patterns regardless of language or orchestrator.

### 1. Agent Initialization Flow

Every agent follows a standard initialization sequence:

```
1. Load Configuration
   └── Environment variables, config files, secrets

2. Configure Observability
   └── Set up Microsoft Agent 365 tracing and telemetry

3. Initialize LLM Client
   └── Create orchestrator-specific AI client (OpenAI, Claude, etc.)

4. Register Tools
   └── Local tools (weather, datetime, etc.)
   └── MCP servers (Graph API, custom tools)

5. Configure Authentication
   └── Bearer token (development)
   └── Auth handlers (production agentic auth)

6. Start HTTP Server
   └── Listen on /api/messages endpoint
```

### 2. Message Processing Flow

All agents process messages using this standard flow:

```
Incoming HTTP Request
        │
        ▼
┌───────────────────┐
│ Authentication    │ ← JWT validation / Auth handlers
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Observability     │ ← Start trace span, set baggage
│ Context Setup     │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Tool Registration │ ← Load MCP servers, local tools
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ LLM Invocation    │ ← Process with AI orchestrator
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Response          │ ← Stream or send response
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Cleanup           │ ← Close connections, end spans
└───────────────────┘
```

### 3. Tool Integration via MCP (Model Context Protocol)

MCP provides a standardized way to extend agent capabilities:

- **MCP Servers**: External services that provide tools (Graph API, custom services)
- **Tool Registration**: Dynamic tool loading based on agent identity
- **Authentication**: Tools are authenticated using the same auth flow as the agent

```
Agent Identity → Tool Configuration Service → MCP Server List → Tool Registration
```

### 4. Authentication Strategies

The samples support multiple authentication approaches:

| Strategy | Use Case | Configuration |
|----------|----------|---------------|
| Bearer Token | Local development/testing | `BEARER_TOKEN` environment variable |
| Auth Handlers | Production agentic or OBO auth | Configured in app settings |
| No Auth | Bare LLM mode (fallback) | No configuration required |

**Authentication Priority:**
1. Bearer token from environment (development)
2. Auth handler (production)
3. No auth fallback (graceful degradation)

### 5. Microsoft Agent 365 Observability

All samples integrate with Agent 365 observability:

```
┌─────────────────────────────────────────────────────────┐
│                 Observability Pipeline                  │
├─────────────────────────────────────────────────────────┤
│  Token Resolver → Trace Exporter → Agent 365 Backend   │
│                                                         │
│  Components:                                            │
│  • Token caching (cached agentic tokens)               │
│  • Baggage propagation (tenant, agent, conversation)   │
│  • Framework-specific instrumentors                     │
│  • Custom span attributes                              │
└─────────────────────────────────────────────────────────┘
```

**Observability Setup Pattern:**
1. Configure token resolver (for authentication)
2. Configure service information (name, namespace)
3. Enable framework-specific instrumentation
4. Start observability manager

### 6. Notification Handling

Agents can receive and process notifications from Agent 365:

- **Email Notifications**: Process incoming emails
- **WPX Comments**: Handle Word document comments
- **Custom Notifications**: Extensible notification types

### 7. Graceful Degradation

All samples support graceful degradation when tools fail:

```
if (toolLoadingFails) {
    if (isDevelopment && SKIP_TOOLING_ON_ERRORS) {
        // Continue with bare LLM mode
        logWarning("Running without MCP tools");
    } else {
        // Fail fast in production
        throw error;
    }
}
```

## Shared Design Principles

### 1. Configuration Management

- **Environment Variables**: Primary configuration source
- **Config Files**: Language-specific formats (appsettings.json, .env, pyproject.toml)
- **User Secrets**: Development-only sensitive values
- **No Hardcoded Secrets**: All secrets via environment or secret managers

### 2. Type Safety

- **C#/.NET**: Strong typing with interfaces and contracts
- **Python**: Type hints with Pydantic validation
- **TypeScript**: Full type definitions, strict mode

### 3. Error Handling

- **Graceful Degradation**: Continue with reduced functionality when possible
- **Meaningful Error Messages**: Include context for debugging
- **Logging**: Comprehensive logging at appropriate levels

### 4. Security

- **JWT Validation**: All production endpoints validate tokens
- **Prompt Injection Protection**: System instructions include security guidelines
- **No Credential Logging**: Sensitive data never logged

## Language-Specific Documentation

For detailed design guidelines specific to each language:

- [.NET Design Guidelines](../dotnet/docs/design.md)
- [Python Design Guidelines](../python/docs/design.md)
- [Node.js Design Guidelines](../nodejs/docs/design.md)

## Sample Agent Documentation

Each sample agent has its own design document with implementation-specific details:

### .NET Samples
- [Agent Framework Sample](../dotnet/agent-framework/sample-agent/docs/design.md)
- [Semantic Kernel Sample](../dotnet/semantic-kernel/sample-agent/docs/design.md)

### Python Samples
- [Agent Framework Sample](../python/agent-framework/sample-agent/docs/design.md)
- [Claude Sample](../python/claude/sample-agent/docs/design.md)
- [CrewAI Sample](../python/crewai/sample_agent/docs/design.md)
- [Google ADK Sample](../python/google-adk/sample-agent/docs/design.md)
- [OpenAI Sample](../python/openai/sample-agent/docs/design.md)

### Node.js Samples
- [Claude Sample](../nodejs/claude/sample-agent/docs/design.md)
- [Devin Sample](../nodejs/devin/sample-agent/docs/design.md)
- [LangChain Sample](../nodejs/langchain/sample-agent/docs/design.md)
- [N8N Sample](../nodejs/n8n/sample-agent/docs/design.md)
- [OpenAI Sample](../nodejs/openai/sample-agent/docs/design.md)
- [Perplexity Sample](../nodejs/perplexity/sample-agent/docs/design.md)
- [Vercel SDK Sample](../nodejs/vercel-sdk/sample-agent/docs/design.md)

## Technology Stack

| Component | C# / .NET | Python | Node.js/TypeScript |
|-----------|-----------|--------|-------------------|
| HTTP Server | ASP.NET Core | aiohttp/FastAPI | Express.js |
| LLM Client | Azure.AI.OpenAI | openai/anthropic | @openai/agents |
| Observability | OpenTelemetry | OpenTelemetry | OpenTelemetry |
| Agent 365 SDK | Microsoft.Agents.* | microsoft_agents.* | @microsoft/agents-* |
| Config Format | appsettings.json | .env/pyproject.toml | .env/package.json |

## Getting Started

1. Choose a language and orchestrator that fits your needs
2. Navigate to the appropriate sample directory
3. Follow the README.md for setup instructions
4. Review the design document for architectural understanding
5. Run and test the sample agent
