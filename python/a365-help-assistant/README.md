# A365 Help Assistant

A Helpdesk Assistant Agent for Microsoft Agent 365, built using the Microsoft Agent SDK, Microsoft Agent 365 SDK, and OpenAI SDK.

## Overview

The A365 Help Assistant is an intelligent helpdesk agent that:

- **Reads and searches documentation** from local resource files
- **Provides accurate answers** based on official Agent 365 documentation
- **Falls back gracefully** with documentation links when answers aren't found
- **Integrates with MCP tools** for extended functionality
- **Supports observability** for monitoring and debugging

## Features

### Core Capabilities

- 📚 **Documentation Search**: Searches local resource files to find relevant information
- 🤖 **Intelligent Responses**: Uses OpenAI/Azure OpenAI to understand queries and formulate helpful answers
- 🔗 **Fallback Links**: Provides official documentation links when specific answers aren't found
- 🛠️ **MCP Tool Integration**: Supports Model Context Protocol tools for extended functionality
- 📊 **Observability**: Built-in tracing and monitoring with Agent 365 observability

### Documentation Coverage

The agent includes documentation covering:
- Getting Started Guide
- Deployment Guide
- Configuration Reference
- Troubleshooting Guide
- API Reference

## Prerequisites

- Python 3.11 or higher
- OpenAI API key or Azure OpenAI credentials
- (Optional) Microsoft 365 tenant for full Agent 365 integration

## Installation

1. **Navigate to the agent directory:**
   ```bash
   cd python/a365-help-assistant
   ```

2. **Install dependencies using uv:**
   ```bash
   uv sync
   ```

   Or using pip:
   ```bash
   pip install -e .
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

## Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
# OpenAI Configuration (choose one)
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o-mini

# OR Azure OpenAI Configuration
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your_azure_key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini

# Server Configuration
PORT=3978

# Authentication (Optional - for production)
CLIENT_ID=your_client_id
TENANT_ID=your_tenant_id
CLIENT_SECRET=your_client_secret
AUTH_HANDLER_NAME=AGENTIC

# Development Settings
ENVIRONMENT=Development
SKIP_TOOLING_ON_ERRORS=true

# Observability
OBSERVABILITY_SERVICE_NAME=a365-help-assistant
OBSERVABILITY_SERVICE_NAMESPACE=agent365-samples
```

## Running the Agent

### Start with Generic Host (Recommended)

```bash
python start_with_generic_host.py
```

This starts the agent with the Microsoft Agents SDK hosting infrastructure.

### Interactive Mode (Standalone Testing)

```bash
python agent.py
```

This runs the agent in interactive mode for local testing without the full hosting infrastructure.

## Usage

Once running, the agent exposes:

- **Messages Endpoint**: `POST http://localhost:3978/api/messages`
- **Health Endpoint**: `GET http://localhost:3978/api/health`

### Example Queries

Ask questions about Agent 365:

- "How do I set up an Agent 365 project?"
- "What environment variables are required?"
- "How do I deploy to Azure?"
- "What authentication options are available?"
- "How do I configure MCP tools?"

## Architecture

```
a365-help-assistant/
├── agent.py                    # Main agent implementation
├── agent_interface.py          # Abstract base class
├── host_agent_server.py        # Generic hosting server
├── start_with_generic_host.py  # Entry point
├── local_authentication_options.py  # Auth configuration
├── token_cache.py              # Token caching utilities
├── pyproject.toml              # Dependencies
├── ToolingManifest.json        # MCP server configuration
└── resources/                  # Documentation files
    ├── getting-started.md
    ├── deployment-guide.md
    ├── configuration-reference.md
    ├── troubleshooting.md
    └── api-reference.md
```

### Key Components

1. **A365HelpAssistant** (agent.py): Main agent class with documentation search capabilities
2. **DocumentationSearchEngine**: Loads and searches documentation files
3. **GenericAgentHost**: Microsoft Agents SDK hosting infrastructure
4. **Built-in Tools**:
   - `search_documentation`: Search docs for relevant information
   - `list_available_documents`: List all loaded documentation
   - `get_document_content`: Get full content of a document
   - `get_documentation_links`: Get official documentation links

## Adding Custom Documentation

Place additional documentation files in the `resources/` folder:

- Supported formats: `.md`, `.txt`, `.rst`, `.html`
- Files are automatically loaded on agent startup
- Subdirectories are supported

Example:
```bash
resources/
├── getting-started.md
├── custom/
│   ├── my-guide.md
│   └── faq.txt
```

## Testing with Agents Playground

1. Start the agent: `python start_with_generic_host.py`
2. Open Microsoft Agents Playground
3. Connect to `http://localhost:3978/api/messages`
4. Start asking questions!

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| "API key required" | Set OPENAI_API_KEY or Azure credentials in .env |
| "Port already in use" | Change PORT in .env or stop conflicting process |
| "No documents found" | Ensure resources/ folder exists and contains .md files |

### Debug Mode

Enable verbose logging:
```env
ENVIRONMENT=Development
LOG_LEVEL=DEBUG
```

## Support

For issues, questions, or feedback:

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-python/issues)
- **Documentation**: [Microsoft Agent 365 Developer Docs](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License.
