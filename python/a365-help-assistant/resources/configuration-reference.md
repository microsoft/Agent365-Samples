# Microsoft Agent 365 - Configuration Reference

## Overview

This document provides a comprehensive reference for all configuration options available in Microsoft Agent 365.

## Environment Variables

### Authentication

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `CLIENT_ID` | string | No* | - | Azure AD Application (client) ID |
| `TENANT_ID` | string | No* | - | Azure AD Tenant ID |
| `CLIENT_SECRET` | string | No* | - | Azure AD Client Secret |
| `BEARER_TOKEN` | string | No* | - | Static bearer token for development |
| `AUTH_HANDLER_NAME` | string | No | - | Name of the authentication handler (e.g., "AGENTIC") |

*At least one authentication method is required for production use.

### OpenAI Configuration

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `OPENAI_API_KEY` | string | Yes** | - | OpenAI API key |
| `OPENAI_MODEL` | string | No | gpt-4o-mini | OpenAI model to use |

### Azure OpenAI Configuration

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `AZURE_OPENAI_ENDPOINT` | string | Yes** | - | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_API_KEY` | string | Yes** | - | Azure OpenAI API key |
| `AZURE_OPENAI_DEPLOYMENT` | string | No | gpt-4o-mini | Azure OpenAI deployment name |

**Either OpenAI or Azure OpenAI credentials are required.

### Server Configuration

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `PORT` | integer | No | 3978 | HTTP server port |
| `ENVIRONMENT` | string | No | Production | Environment name (Development/Production) |
| `SKIP_TOOLING_ON_ERRORS` | boolean | No | false | Allow fallback to bare LLM mode on tool errors (Development only) |

### Observability Configuration

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `OBSERVABILITY_SERVICE_NAME` | string | No | agent-service | Service name for telemetry |
| `OBSERVABILITY_SERVICE_NAMESPACE` | string | No | agent365-samples | Service namespace for telemetry |

## Configuration Files

### ToolingManifest.json

Defines MCP (Model Context Protocol) servers for tool integration:

```json
{
  "mcpServers": [
    {
      "mcpServerName": "mcp_MailTools",
      "mcpServerUniqueName": "mcp_MailTools"
    },
    {
      "mcpServerName": "mcp_CalendarTools",
      "mcpServerUniqueName": "mcp_CalendarTools"
    }
  ]
}
```

### a365.config.json

Optional configuration file for additional agent settings:

```json
{
  "agent": {
    "name": "MyAgent",
    "description": "My custom agent",
    "version": "1.0.0"
  },
  "features": {
    "observability": true,
    "notifications": true
  }
}
```

## Model Settings

### Temperature

Controls randomness in responses:
- 0.0 - 0.3: More deterministic, factual responses
- 0.4 - 0.7: Balanced creativity and accuracy
- 0.8 - 1.0: More creative, varied responses

### Max Tokens

Maximum number of tokens in the response. Default varies by model.

### Top P

Nucleus sampling parameter. Alternative to temperature for controlling randomness.

## Authentication Modes

### 1. Anonymous Mode

No authentication required. Suitable for development and testing:

```
# No auth variables set
PORT=3978
OPENAI_API_KEY=your_key
```

### 2. Bearer Token Mode

Static token for development:

```
BEARER_TOKEN=your_bearer_token
OPENAI_API_KEY=your_key
```

### 3. Client Credentials Mode

Production authentication with Azure AD:

```
CLIENT_ID=your_client_id
TENANT_ID=your_tenant_id
CLIENT_SECRET=your_client_secret
AUTH_HANDLER_NAME=AGENTIC
```

## MCP Tool Configuration

### Registering Custom Tools

```python
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)

config_service = McpToolServerConfigurationService()
# Tools are loaded from ToolingManifest.json
```

### Tool Authentication

MCP tools inherit authentication from the agent. Ensure proper auth configuration for tool access.

## Best Practices

1. **Use environment variables for secrets** - Never hardcode credentials
2. **Set appropriate temperature** - Lower for factual, higher for creative
3. **Configure observability** - Enable tracing for debugging and monitoring
4. **Use production auth** - Don't use anonymous mode in production
5. **Validate configuration** - Check all required variables at startup

## Troubleshooting Configuration

| Issue | Cause | Solution |
|-------|-------|----------|
| "API key required" | Missing OpenAI credentials | Set OPENAI_API_KEY or Azure credentials |
| "Authentication failed" | Invalid credentials | Verify CLIENT_ID, TENANT_ID, CLIENT_SECRET |
| "MCP server not found" | Invalid ToolingManifest.json | Check server name configuration |
| "Port already in use" | Another process using port | Change PORT or stop conflicting process |
