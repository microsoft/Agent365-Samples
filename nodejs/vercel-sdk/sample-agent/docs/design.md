# Vercel AI SDK Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using the Vercel AI SDK as the orchestrator. It showcases Vercel's unified AI interface and streaming capabilities integrated with Microsoft Agent 365.

## What This Sample Demonstrates

- Vercel AI SDK integration (`ai`)
- Unified provider interface
- Streaming responses
- Tool calling with Vercel SDK
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
│  │              VercelAIClient                                  ││
│  │  generateText() / streamText() → Tools → Response            ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/client.ts
Vercel AI SDK-specific client:
- Provider configuration (OpenAI, Anthropic, etc.)
- Text generation with tools
- Streaming support

## Vercel AI SDK-Specific Patterns

### Text Generation with Tools
```typescript
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';

class VercelAIClient implements Client {
  async invokeAgent(prompt: string): Promise<string> {
    const result = await generateText({
      model: openai('gpt-4o'),
      system: this.systemPrompt,
      prompt,
      tools: this.tools,
      maxSteps: 5,  // Allow tool use loops
    });

    return result.text;
  }
}
```

### MCP to Vercel Tool Conversion
```typescript
import { tool } from 'ai';
import { z } from 'zod';

function convertMcpToVercelTools(mcpTools: MCPTool[]) {
  return Object.fromEntries(
    mcpTools.map(mcpTool => [
      mcpTool.name,
      tool({
        description: mcpTool.description,
        parameters: z.object(mcpTool.inputSchema),
        execute: async (args) => mcpTool.execute(args),
      }),
    ])
  );
}
```

### Streaming Responses
```typescript
import { streamText } from 'ai';

async invokeAgentStreaming(prompt: string, onChunk: (text: string) => void): Promise<string> {
  const result = await streamText({
    model: openai('gpt-4o'),
    prompt,
    tools: this.tools,
  });

  let fullText = '';
  for await (const textPart of result.textStream) {
    fullText += textPart;
    onChunk(textPart);
  }

  return fullText;
}
```

## Configuration

### .env file
```bash
# Provider Configuration
OPENAI_API_KEY=sk-...
# Or use other providers:
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_GENERATIVE_AI_API_KEY=...

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
2. MyAgent routes to Vercel AI client
3. generateText() with tools
4. Tool use steps (up to maxSteps)
5. Final response returned
```

## Provider Flexibility

```typescript
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// Switch providers easily
const model = process.env.PROVIDER === 'anthropic'
  ? anthropic('claude-3-5-sonnet-20241022')
  : process.env.PROVIDER === 'google'
  ? google('gemini-1.5-pro')
  : openai('gpt-4o');
```

## Dependencies

```json
{
  "dependencies": {
    "ai": "^3.0.0",
    "@ai-sdk/openai": "^0.0.1",
    "@ai-sdk/anthropic": "^0.0.1",
    "zod": "^3.22.0",
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

1. **Provider Selection**: OpenAI, Anthropic, Google, etc.
2. **Streaming**: Enable/disable streaming
3. **Tool Definitions**: Vercel AI tool format
4. **Max Steps**: Control tool use iterations
5. **Schema Validation**: Zod schemas for tools
