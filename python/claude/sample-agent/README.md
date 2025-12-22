# Claude Sample Agent - Python

This directory contains a sample agent implementation using Python and Anthropic's Claude Agent SDK with extended thinking capabilities. This sample demonstrates how to build an agent using the Agent365 framework with Python and Claude Agent SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Built-in Claude tools (Read, Write, WebSearch, Bash, Grep) for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11+
- Anthropic Claude API access (API key)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)

## Running the Agent

### 1. Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

### 2. Set Up Environment

```bash
# Copy the template
cp .env.template .env

# Edit .env and set your API key
# ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Install Dependencies

```bash
# Create virtual environment and install
uv venv
uv pip install -e .
```

### 4. Run the Agent

```bash
uv run python start_with_generic_host.py
```

The agent will start on `http://localhost:3978` and can be tested with the Agents Playground:

```bash
# In a new terminal
agentsplayground
```

## Environment Variables

### Required
```env
ANTHROPIC_API_KEY=sk-ant-...     # Your Claude API key
```

### Optional
```env
# Authentication
USE_AGENTIC_AUTH=false           # true for production auth
AGENT_ID=user123                 # Agent identifier

# Observability
ENABLE_OBSERVABILITY=true        # Enable telemetry
OBSERVABILITY_SERVICE_NAME=claude-agent
OBSERVABILITY_SERVICE_NAMESPACE=agents.samples

# Server
PORT=3978                        # HTTP server port
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Microsoft 365 Agents Playground / Client       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  host_agent_server.py                           │
│  - HTTP endpoint (/api/messages)                │
│  - Authentication middleware                    │
│  - Notification routing                         │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  agent.py (ClaudeAgent)                         │
│  - Message processing                           │
│  - Notification handling                        │
│  - Claude SDK integration                       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Claude Agent SDK                               │
│  - Extended thinking                            │
│  - Built-in tools                               │
│  - Streaming responses                          │
└─────────────────────────────────────────────────┘
```

## Built-in Claude Tools

The Claude Agent SDK provides these tools out of the box:

- **Read**: Read files from the workspace
- **Write**: Create/modify files
- **WebSearch**: Search the web for information
- **Bash**: Execute shell commands
- **Grep**: Search file contents

No additional MCP server configuration needed!

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Support

- [Claude Agent SDK](https://anthropic.mintlify.app/en/api/agent-sdk/overview)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/)
- [Microsoft Agents A365 Python](https://github.com/microsoft/Agent365-python)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.