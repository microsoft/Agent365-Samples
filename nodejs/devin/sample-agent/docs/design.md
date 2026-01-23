# Devin Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using Cognition's Devin AI as the orchestrator. It showcases integration patterns for Devin's code-focused capabilities with Microsoft Agent 365.

## What This Sample Demonstrates

- Devin AI integration
- Code-focused agent capabilities
- MCP server tool registration
- Microsoft Agent 365 observability
- TypeScript implementation

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       index.ts                                   │
│  Express server + /api/messages endpoint                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       agent.ts                                   │
│  MyAgent extends AgentApplication<TurnState>                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       client.ts                                  │
│  DevinClient - Devin API integration                             │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/client.ts
Devin-specific client:
- Devin API configuration
- Code task handling
- Response processing

## Configuration

### .env file
```bash
# Devin Configuration
DEVIN_API_KEY=...
DEVIN_API_ENDPOINT=...

# Authentication
BEARER_TOKEN=...
CLIENT_ID=...
TENANT_ID=...

# Observability
ENABLE_OBSERVABILITY=true
```

## Message Flow

```
1. HTTP POST /api/messages
2. MyAgent routes to Devin client
3. Devin processes code-related tasks
4. Response returned
```

## Dependencies

```json
{
  "dependencies": {
    "@microsoft/agents-hosting": "^0.0.1",
    "@microsoft/agents-a365-observability": "^0.0.1",
    "express": "^4.18.0"
  }
}
```

## Running the Agent

```bash
npm install
npm run build
npm start
```

## Extension Points

1. **Task Types**: Configure Devin task categories
2. **Code Contexts**: Provide repository context
3. **Tool Integration**: MCP tools for code operations
