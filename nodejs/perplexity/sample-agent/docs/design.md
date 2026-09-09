# Perplexity Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using Perplexity AI as the orchestrator. It showcases Perplexity's search-augmented generation capabilities integrated with Microsoft Agent 365.

## What This Sample Demonstrates

- Perplexity API integration
- Search-augmented generation
- Citation handling
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
│  │              PerplexityClient                                ││
│  │  Perplexity API → Search + Generate → Response + Citations   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/otel.ts
Imported first by `src/index.ts`, this bootstrap loads dotenv and initializes the
legacy `ObservabilityManager` from
`@microsoft/agents-a365-observability@0.1.0-preview.115` exactly once, using
`.withTokenResolver(createObservabilityTokenResolver())`. Explicit
`exporterOptions.useS2SEndpoint = true` selects the legacy service route
`/observabilityService/tenants/{tenantId}/agents/{agentId}/traces?api-version=1`.
Business Graph/presence/OBO authentication is independent and unchanged.
The OBS resolver obtains an app-only token for the actual agent, rejecting all
`scp` claims. `OtelWrite` is the recommended standard prerequisite, not proof
of admission through the separate legacy service-principal and tenant gates.
The route contract is source-verified, not live-validated; see the sample README.

SDK imports use the legacy `TenantDetails`, `InvokeAgentDetails`, `ExecutionType`,
and scope signatures; the public OpenTelemetry distribution is not used.

### src/client.ts
Perplexity-specific client:
- Perplexity API configuration
- Search-augmented generation
- Citation extraction

## Perplexity-Specific Patterns

### API Integration
```typescript
class PerplexityClient implements Client {
  private apiKey: string;
  private baseUrl = 'https://api.perplexity.ai';

  async invokeAgent(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const result = await response.json();
    return this.formatResponseWithCitations(result);
  }

  private formatResponseWithCitations(result: any): string {
    const content = result.choices[0].message.content;
    const citations = result.citations || [];

    if (citations.length > 0) {
      return `${content}\n\nSources:\n${citations.map((c, i) => `[${i+1}] ${c}`).join('\n')}`;
    }
    return content;
  }
}
```

## Configuration

### .env file
```bash
# Perplexity Configuration
PERPLEXITY_API_KEY=pplx-...
PERPLEXITY_MODEL=llama-3.1-sonar-large-128k-online

# Authentication
BEARER_TOKEN=...
CLIENT_ID=...
TENANT_ID=...

# Observability
ENABLE_A365_OBSERVABILITY_EXPORTER=true
AGENT365_OBS_TENANT_ID=<<YOUR_TENANT_ID>>
AGENT365_OBS_AGENT_ID=<<YOUR_AGENT_INSTANCE_CLIENT_ID>>
AGENT365_OBS_BLUEPRINT_CLIENT_ID=<<YOUR_BLUEPRINT_CLIENT_ID>>
AGENT365_OBS_BLUEPRINT_CLIENT_SECRET=<<YOUR_BLUEPRINT_CLIENT_SECRET>>
```

## Message Flow

```
1. HTTP POST /api/messages
2. MyAgent routes to Perplexity client
3. Perplexity searches and generates
4. Response with citations returned
```

## Dependencies

```json
{
  "dependencies": {
    "@microsoft/agents-hosting": "^0.0.1",
    "@microsoft/agents-a365-observability": "0.1.0-preview.115",
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

1. **Model Selection**: Different Perplexity models
2. **Search Focus**: Web, academic, writing, etc.
3. **Citation Formatting**: Custom citation styles
4. **Follow-up Questions**: Suggested queries
