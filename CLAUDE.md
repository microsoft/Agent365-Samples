# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **Agent365-Samples** repository containing sample agents demonstrating the Microsoft Agent 365 SDK across three languages (C#/.NET, Python, Node.js/TypeScript) and multiple AI orchestrators (OpenAI, Claude, Semantic Kernel, Agent Framework, LangChain, CrewAI, etc.).

The Microsoft Agent 365 SDK extends the Microsoft 365 Agents SDK with enterprise-grade capabilities for observability, notifications, MCP tooling, and runtime utilities.

## Repository Structure

```
Agent365-Samples/
├── dotnet/                    # C#/.NET samples
│   ├── agent-framework/      # Agent Framework orchestrator
│   └── semantic-kernel/      # Semantic Kernel orchestrator
├── python/                    # Python samples
│   ├── agent-framework/
│   ├── openai/
│   ├── claude/
│   ├── crewai/
│   └── google-adk/
├── nodejs/                    # Node.js/TypeScript samples
│   ├── openai/
│   ├── claude/
│   ├── langchain/
│   ├── devin/
│   ├── n8n/
│   ├── perplexity/
│   └── vercel-sdk/
├── docs/                      # Repository-wide documentation
│   └── design.md             # Architectural patterns
├── prompts/                   # AI development prompts
└── scripts/                   # Utility scripts
```

Each language directory contains a `docs/design.md` with language-specific design patterns.

## Common Development Commands

### C# / .NET

**Build:**
```bash
dotnet build <path-to-sln-or-csproj>
```

**Run:**
```bash
dotnet run --project <path-to-csproj>
```

**Solutions:**
- `dotnet/agent-framework/AgentFrameworkSample.sln`
- `dotnet/semantic-kernel/SemanticKernelSampleAgent.sln`

### Python

**Setup:**
```bash
cd <sample-directory>
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -e .
```

**Run:**
```bash
python host_agent_server.py
# or
python start_with_generic_host.py
```

Python samples use `pyproject.toml` for dependency management. Most samples support `uv` for faster dependency resolution.

### Node.js / TypeScript

**Setup:**
```bash
cd <sample-directory>
npm install
```

**Build:**
```bash
npm run build
```

**Run:**
```bash
npm start           # Production mode
npm run dev         # Development mode with hot reload
```

## Architecture Patterns

All sample agents follow a consistent initialization and message processing flow:

### Initialization Flow
1. Load configuration (environment variables, config files)
2. Configure observability (Agent 365 tracing/telemetry)
3. Initialize LLM client (orchestrator-specific)
4. Register tools (local tools + MCP servers)
5. Configure authentication (bearer token or auth handlers)
6. Start HTTP server (listen on `/api/messages`)

### Message Processing Flow
1. **Authentication**: JWT validation / auth handlers
2. **Observability Context Setup**: Start trace span, set baggage (tenant, agent, conversation)
3. **Tool Registration**: Load MCP servers and local tools
4. **LLM Invocation**: Process with AI orchestrator
5. **Response**: Stream or send response
6. **Cleanup**: Close connections, end spans

### Authentication Strategies

Authentication is configured in this priority order:
1. **Bearer Token** (development): Set `BEARER_TOKEN` environment variable
2. **Auth Handlers** (production): Configured in `appsettings.json` (C#), `.env` (Python/Node.js)
3. **No Auth** (fallback): Bare LLM mode with graceful degradation

### Configuration Files

- **C#**: `appsettings.json`, `appsettings.Development.json`
- **Python**: `.env`, `pyproject.toml`
- **Node.js**: `.env`, `package.json`

Configuration typically includes:
- LLM client settings (OpenAI/Azure OpenAI endpoints and API keys)
- Observability settings (Agent 365 tracing)
- Authentication settings (bearer token or auth handlers)
- MCP tooling configuration

### Observability

All samples integrate Microsoft Agent 365 observability:
- Token caching for agentic auth tokens
- Baggage propagation (tenant, agent, conversation IDs)
- Framework-specific instrumentation (OpenTelemetry)
- Custom span attributes for tracing

### MCP (Model Context Protocol) Tooling

Agents can dynamically load tools from MCP servers:
- Tools are configured per agent identity
- Authentication flows through the same mechanism as the agent
- Samples demonstrate both local tools (weather, datetime) and remote MCP servers (Graph API)

## Key Code Locations

### C# / .NET
- **Entry point**: `Program.cs`
- **Agent implementation**: `Agent/MyAgent.cs` (or similar)
- **Tools**: `Tools/` directory
- **Configuration**: `appsettings.json`

### Python
- **Entry point**: `host_agent_server.py` or `start_with_generic_host.py`
- **Agent implementation**: `agent.py`
- **Configuration**: `.env` or embedded in `pyproject.toml`

### Node.js / TypeScript
- **Entry point**: `src/index.ts`
- **Agent implementation**: `src/agent.ts`
- **LLM client**: `src/client.ts`
- **Token cache**: `src/token-cache.ts`
- **Configuration**: `.env`

## Code Quality Rules

### Copyright Headers
All source files MUST have Microsoft copyright headers:

**C# (`.cs`):**
```csharp
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
```

**Python (`.py`):**
```python
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
```

**JavaScript/TypeScript (`.js`, `.ts`):**
```javascript
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
```

**Exclusions**: Auto-generated files, test files, configuration files (`.json`, `.yaml`, `.md`), and third-party code.

### Legacy Reference Check
Never use "Kairo" in code - this is a legacy reference that should be replaced with appropriate Agent 365 terminology.

### Security
- Never commit API keys, tokens, or secrets
- Use placeholders like `<<YOUR_API_KEY>>` or `<<PLACEHOLDER>>` in config examples
- Use environment variables, user secrets, or key vaults for sensitive data

## Sample Documentation Standards

Each sample SHOULD have:
1. **README.md** with:
   - What the sample demonstrates
   - Prerequisites (runtime version, API keys, tools)
   - Configuration section with example config snippets
   - How to run instructions
   - Testing options (Playground, WebChat, Teams/M365)
   - Troubleshooting section
2. **Agent Code Walkthrough** (optional but recommended)
3. **manifest/** folder with:
   - `manifest.json` (Teams app manifest)
   - `color.png` (192x192 icon)
   - `outline.png` (32x32 icon)

## Technology Stack

| Component | C#/.NET | Python | Node.js/TypeScript |
|-----------|---------|--------|-------------------|
| HTTP Server | ASP.NET Core | aiohttp/FastAPI | Express.js |
| LLM Client | Azure.AI.OpenAI | openai/anthropic | @openai/agents |
| Observability | OpenTelemetry | OpenTelemetry | OpenTelemetry |
| Agent 365 SDK | Microsoft.Agents.* | microsoft_agents.* | @microsoft/agents-* |

## Additional Documentation

- [Main README](README.md): Overview and links to SDK documentation
- [Architecture Design](docs/design.md): Cross-cutting architectural patterns
- [Contributing Guide](CONTRIBUTING.md): How to contribute
- [Copilot Instructions](.github/copilot-instructions.md): Automated code review rules

For language-specific design patterns, see:
- [.NET Design Guidelines](dotnet/docs/design.md)
- [Python Design Guidelines](python/docs/design.md)
- [Node.js Design Guidelines](nodejs/docs/design.md)

## Official Documentation

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Microsoft 365 Agents SDK Documentation](https://learn.microsoft.com/microsoft-365/agents-sdk/)
