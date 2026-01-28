# Microsoft Agent 365 - Getting Started Guide

## Overview

Microsoft Agent 365 is a comprehensive platform for building, deploying, and managing intelligent agents that integrate with Microsoft 365 services.

## Prerequisites

Before you begin, ensure you have:

- Python 3.11 or higher
- An Azure subscription
- Microsoft 365 tenant with appropriate permissions
- OpenAI API key or Azure OpenAI credentials

## Installation

### Using pip

```bash
pip install microsoft-agents-hosting-aiohttp
pip install microsoft-agents-hosting-core
pip install microsoft-agents-authentication-msal
pip install microsoft_agents_a365_tooling
pip install microsoft_agents_a365_observability_core
pip install openai-agents
```

### Using uv (recommended)

```bash
uv sync
```

## Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/microsoft/Agent365-Samples.git
   cd Agent365-Samples/python
   ```

2. **Set up environment variables:**
   Create a `.env` file with:
   ```
   OPENAI_API_KEY=your_openai_api_key
   # Or for Azure OpenAI:
   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   AZURE_OPENAI_API_KEY=your_azure_openai_key
   AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
   ```

3. **Run the agent:**
   ```bash
   python start_with_generic_host.py
   ```

## Agent Architecture

### Core Components

- **AgentInterface**: Abstract base class that all agents must inherit from
- **GenericAgentHost**: Hosting infrastructure for running agents
- **MCP Tool Integration**: Connect external tools via Model Context Protocol

### Key Methods

- `initialize()`: Set up agent resources and connections
- `process_user_message()`: Handle incoming user messages
- `cleanup()`: Clean up resources when shutting down

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key | Yes (if not using Azure) |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL | Yes (if using Azure) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | Yes (if using Azure) |
| `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI deployment name | Yes (if using Azure) |
| `PORT` | Server port (default: 3978) | No |
| `BEARER_TOKEN` | Bearer token for MCP authentication | No |
| `AUTH_HANDLER_NAME` | Authentication handler name | No |

## Next Steps

- [Deployment Guide](deployment-guide.md)
- [Configuration Reference](configuration-reference.md)
- [Troubleshooting](troubleshooting.md)

## Support

For issues and questions, visit:
- GitHub Issues: https://github.com/microsoft/Agent365-python/issues
- Documentation: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/
