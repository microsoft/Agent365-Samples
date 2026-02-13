# Claude Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using Anthropic's Claude AI as the orchestrator in a Node.js/TypeScript environment. It showcases Claude-specific patterns for tool use and integration with Microsoft Agent 365.

## What This Sample Demonstrates

- Anthropic Claude SDK integration (`@anthropic-ai/sdk`)
- Claude tool use (function calling) patterns
- MCP server tool registration for Claude
- Microsoft Agent 365 observability
- TypeScript type safety

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
│  │              ClaudeClient                                    ││
│  │  Anthropic SDK → messages.create() → Tool Use Loop           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/index.ts
Application entry point with Express server.

### src/agent.ts
Agent application routing messages to Claude client.

### src/client.ts
Claude-specific client implementation:
- Anthropic SDK configuration
- Tool use handling
- MCP tool conversion to Claude format

## Claude-Specific Patterns

### Tool Use Loop
```typescript
class ClaudeClient implements Client {
  private anthropic: Anthropic;

  async invokeAgent(prompt: string): Promise<string> {
    let messages: MessageParam[] = [
      { role: 'user', content: prompt }
    ];

    while (true) {
      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: this.systemPrompt,
        tools: this.tools,
        messages,
      });

      // Check for tool use
      if (response.stop_reason === 'tool_use') {
        const toolUse = response.content.find(c => c.type === 'tool_use');
        const toolResult = await this.executeTool(toolUse);

        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: toolResult,
          }]
        });
      } else {
        // Extract text response
        const textBlock = response.content.find(c => c.type === 'text');
        return textBlock?.text || '';
      }
    }
  }
}
```

### MCP to Claude Tool Conversion
```typescript
function convertMcpToolsToClaude(mcpTools: MCPTool[]): Tool[] {
  return mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
```

## Configuration

### .env file
```bash
# Claude Configuration
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-3-5-sonnet-20241022

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
2. MyAgent routes to Claude client
3. Claude processes message
4. Tool use loop (if tools requested)
5. Final text response returned
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@microsoft/agents-hosting": "^0.0.1",
    "@microsoft/agents-a365-observability": "^0.0.1",
    "@microsoft/agents-a365-tooling": "^0.0.1",
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

1. **Model Selection**: Choose different Claude models
2. **Tool Definitions**: Add custom Claude tools
3. **System Prompts**: Customize agent behavior
4. **Streaming**: Enable streaming responses
