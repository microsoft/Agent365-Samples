# Node.js / TypeScript Design Guidelines

## Overview

This document describes the design patterns and conventions for Node.js/TypeScript sample agents in the Agent365-Samples repository. All Node.js samples use TypeScript for type safety and follow Express.js patterns for HTTP handling.

## Supported Orchestrators

| Orchestrator | Description | Sample Location |
|--------------|-------------|-----------------|
| Claude | Anthropic's Claude AI | [claude/sample-agent](../claude/sample-agent/) |
| Devin | Cognition's Devin AI | [devin/sample-agent](../devin/sample-agent/) |
| LangChain | LangChain.js framework | [langchain/sample-agent](../langchain/sample-agent/) |
| N8N | N8N workflow automation | [n8n/sample-agent](../n8n/sample-agent/) |
| OpenAI | OpenAI Agents SDK | [openai/sample-agent](../openai/sample-agent/) |
| Perplexity | Perplexity AI | [perplexity/sample-agent](../perplexity/sample-agent/) |
| Vercel SDK | Vercel AI SDK | [vercel-sdk/sample-agent](../vercel-sdk/sample-agent/) |

## Project Structure

```
sample-agent/
├── src/                      # TypeScript source files
│   ├── index.ts             # Application entry point
│   ├── agent.ts             # Agent application class
│   ├── client.ts            # LLM client wrapper
│   └── token-cache.ts       # Token caching utilities
├── dist/                     # Compiled JavaScript output
├── package.json             # NPM configuration
├── tsconfig.json            # TypeScript configuration
├── ToolingManifest.json     # MCP tool manifest
├── .env                     # Environment variables
└── README.md                # Documentation
```

## Core Patterns

### 1. Application Entry Point (index.ts)

```typescript
import { configDotenv } from 'dotenv';
configDotenv();  // Load env vars before other imports

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express';
import { agentApplication } from './agent';

const isProduction = Boolean(process.env.WEBSITE_SITE_NAME) || process.env.NODE_ENV === 'production';
const authConfig: AuthConfiguration = isProduction ? loadAuthConfigFromEnv() : {};

const server = express();
server.use(express.json());
server.use(authorizeJWT(authConfig));

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.PORT) || 3978;
server.listen(port, host, async () => {
  console.log(`Server listening on ${host}:${port}`);
});
```

### 2. Agent Application (agent.ts)

```typescript
import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';

export class MyAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      startTypingTimer: true,
      storage: new MemoryStorage(),
      authorization: {
        agentic: {
          type: 'agentic',
        }
      }
    });

    // Route notifications
    this.onAgentNotification("agents:*", async (context, state, notification) => {
      await this.handleAgentNotificationActivity(context, state, notification);
    }, 1, [MyAgent.authHandlerName]);

    // Route messages
    this.onActivity(ActivityTypes.Message, async (context, state) => {
      await this.handleAgentMessageActivity(context, state);
    }, [MyAgent.authHandlerName]);
  }

  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    // Set up observability baggage
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).build();

    // Preload observability token
    await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        const client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext);
        const response = await client.invokeAgentWithScope(userMessage);
        await turnContext.sendActivity(response);
      });
    } finally {
      baggageScope.dispose();
    }
  }

  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    await AgenticTokenCacheInstance.RefreshObservabilityToken(
      agentId,
      tenantId,
      turnContext,
      this.authorization,
      getObservabilityAuthenticationScope()
    );
  }
}

export const agentApplication = new MyAgent();
```

### 3. LLM Client (client.ts)

```typescript
import { Agent, run } from '@openai/agents';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-openai';
import {
  ObservabilityManager,
  InferenceScope,
  Builder,
} from '@microsoft/agents-a365-observability';
import { OpenAIAgentsTraceInstrumentor } from '@microsoft/agents-a365-observability-extensions-openai';

export interface Client {
  invokeAgentWithScope(prompt: string): Promise<string>;
}

// Configure observability
export const a365Observability = ObservabilityManager.configure((builder: Builder) => {
  builder
    .withService('Sample Agent', '1.0.0')
    .withTokenResolver((agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
    );
});

// Initialize instrumentation
const openAIAgentsTraceInstrumentor = new OpenAIAgentsTraceInstrumentor({
  enabled: true,
  tracerName: 'openai-agent-auto-instrumentation',
});

a365Observability.start();
openAIAgentsTraceInstrumentor.enable();

const toolService = new McpToolRegistrationService();

export async function getClient(
  authorization: Authorization,
  authHandlerName: string,
  turnContext: TurnContext
): Promise<Client> {
  const agent = new Agent({
    name: 'OpenAI Agent',
    instructions: `You are a helpful assistant...`,
  });

  // Register MCP tools
  try {
    await toolService.addToolServersToAgent(
      agent,
      authorization,
      authHandlerName,
      turnContext,
      process.env.BEARER_TOKEN || "",
    );
  } catch (error) {
    console.warn('Failed to register MCP tool servers:', error);
  }

  return new OpenAIClient(agent);
}

class OpenAIClient implements Client {
  constructor(private agent: Agent) {}

  async invokeAgentWithScope(prompt: string): Promise<string> {
    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
    try {
      return await scope.withActiveSpanAsync(async () => {
        const result = await run(this.agent, prompt);
        scope.recordOutputMessages([result.finalOutput]);
        return result.finalOutput;
      });
    } finally {
      scope.dispose();
    }
  }
}
```

### 4. Token Caching (token-cache.ts)

```typescript
const tokenCache = new Map<string, string>();

export function createAgenticTokenCacheKey(agentId: string, tenantId: string): string {
  return `${agentId}:${tenantId}`;
}

export function tokenResolver(agentId: string, tenantId: string): string | undefined {
  const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
  return tokenCache.get(cacheKey);
}

export default tokenCache;
```

## Key NPM Packages

| Package | Purpose |
|---------|---------|
| `@microsoft/agents-hosting` | Agent hosting framework |
| `@microsoft/agents-activity` | Activity types and helpers |
| `@microsoft/agents-a365-observability` | Agent 365 tracing |
| `@microsoft/agents-a365-observability-hosting` | Hosting observability utilities |
| `@microsoft/agents-a365-tooling-extensions-*` | MCP tool integration |
| `@microsoft/agents-a365-notifications` | Notification handling |
| `@openai/agents` | OpenAI Agents SDK |
| `express` | HTTP server framework |
| `typescript` | TypeScript compiler |

## TypeScript Configuration

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Package Configuration

**package.json scripts:**
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "watch": "tsc -w"
  }
}
```

## Environment Configuration

**.env file:**
```bash
# Server
PORT=3978
NODE_ENV=development

# LLM Configuration
OPENAI_API_KEY=sk-...
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_API_KEY=...

# Authentication
BEARER_TOKEN=...
CLIENT_ID=...
TENANT_ID=...
CLIENT_SECRET=...

# Observability
Use_Custom_Resolver=false
```

## Notification Handling

```typescript
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

async handleAgentNotificationActivity(
  context: TurnContext,
  state: TurnState,
  notification: AgentNotificationActivity
) {
  switch (notification.notificationType) {
    case NotificationType.EmailNotification:
      await this.handleEmailNotification(context, state, notification);
      break;
    default:
      await context.sendActivity(`Received: ${notification.notificationType}`);
  }
}

private async handleEmailNotification(
  context: TurnContext,
  state: TurnState,
  activity: AgentNotificationActivity
): Promise<void> {
  const emailNotification = activity.emailNotification;

  const client = await getClient(this.authorization, MyAgent.authHandlerName, context);
  const response = await client.invokeAgentWithScope(
    `Process email from ${context.activity.from?.name}...`
  );

  const emailResponse = createEmailResponseActivity(response);
  await context.sendActivity(emailResponse);
}
```

## Observability Integration

```typescript
// Configure observability manager
const observability = ObservabilityManager.configure((builder: Builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  exporterOptions.maxQueueSize = 10;

  builder
    .withService('TypeScript Sample Agent', '1.0.0')
    .withExporterOptions(exporterOptions)
    .withTokenResolver((agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
    );
});

// Enable framework instrumentation
const instrumentor = new OpenAIAgentsTraceInstrumentor({
  enabled: true,
  tracerName: 'openai-agent-instrumentation',
  tracerVersion: '1.0.0'
});

observability.start();
instrumentor.enable();

// Use inference scope for tracing
const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
try {
  await scope.withActiveSpanAsync(async () => {
    // LLM invocation
    scope.recordInputMessages([prompt]);
    const response = await invokeAgent(prompt);
    scope.recordOutputMessages([response]);
    scope.recordInputTokens(45);
    scope.recordOutputTokens(78);
  });
} finally {
  scope.dispose();
}
```

## Build and Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run production
npm start

# Run development (with ts-node)
npm run dev

# Watch mode
npm run watch
```

## Sample Agents

- [Claude Sample Design](../claude/sample-agent/docs/design.md)
- [Devin Sample Design](../devin/sample-agent/docs/design.md)
- [LangChain Sample Design](../langchain/sample-agent/docs/design.md)
- [OpenAI Sample Design](../openai/sample-agent/docs/design.md)
- [Perplexity Sample Design](../perplexity/sample-agent/docs/design.md)
- [Vercel SDK Sample Design](../vercel-sdk/sample-agent/docs/design.md)
