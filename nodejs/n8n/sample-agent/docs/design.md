# N8N Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using N8N workflow automation as the orchestrator. It showcases how to integrate N8N's workflow capabilities with Microsoft Agent 365.

## What This Sample Demonstrates

- N8N workflow integration
- Workflow-based agent orchestration
- Webhook triggers for Agent 365 messages
- MCP tool integration
- Microsoft Agent 365 observability

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
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              N8NClient                                       ││
│  │  Webhook Trigger → N8N Workflow → Response                   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    N8N Workflow                                  │
│  Webhook → AI Node → Tool Nodes → Response Node                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/client.ts
N8N-specific client:
- Webhook endpoint configuration
- Workflow trigger
- Response handling

## N8N-Specific Patterns

### Workflow Trigger
```typescript
class N8NClient implements Client {
  private webhookUrl: string;

  async invokeAgent(prompt: string): Promise<string> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: prompt,
        context: this.context,
      }),
    });

    const result = await response.json();
    return result.response;
  }
}
```

## Configuration

### .env file
```bash
# N8N Configuration
N8N_WEBHOOK_URL=https://your-n8n.com/webhook/agent
N8N_API_KEY=...

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
2. MyAgent routes to N8N client
3. N8N webhook triggered
4. Workflow executes
5. Response returned via webhook
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

1. **Workflow Design**: Complex N8N workflows
2. **Tool Nodes**: N8N nodes as tools
3. **Error Handling**: Workflow error paths
4. **Async Workflows**: Long-running processes
