# LangChain Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using LangChain.js as the orchestrator. It showcases LangChain's chain and agent patterns integrated with Microsoft Agent 365.

## What This Sample Demonstrates

- LangChain.js integration (`langchain`)
- Chain and agent patterns
- LangChain tool integration with MCP
- Memory and conversation history
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
│  │              LangChainClient                                 ││
│  │  ChatOpenAI → AgentExecutor → Tools → Response               ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Memory                                          ││
│  │  BufferMemory for conversation history                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/client.ts
LangChain-specific client:
- ChatOpenAI model configuration
- AgentExecutor setup
- Tool conversion from MCP
- Memory management

## LangChain-Specific Patterns

### Agent Setup
```typescript
import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
import { BufferMemory } from 'langchain/memory';

class LangChainClient implements Client {
  private executor: AgentExecutor;
  private memory: BufferMemory;

  async initialize(mcpTools: MCPTool[]) {
    const model = new ChatOpenAI({
      modelName: 'gpt-4o',
      temperature: 0.7,
    });

    const tools = this.convertMcpToLangChainTools(mcpTools);

    const agent = await createOpenAIFunctionsAgent({
      llm: model,
      tools,
      prompt: this.prompt,
    });

    this.executor = new AgentExecutor({
      agent,
      tools,
      memory: this.memory,
    });
  }

  async invokeAgent(prompt: string): Promise<string> {
    const result = await this.executor.invoke({
      input: prompt,
    });
    return result.output;
  }
}
```

### MCP to LangChain Tool Conversion
```typescript
import { DynamicTool } from '@langchain/core/tools';

function convertMcpToLangChainTools(mcpTools: MCPTool[]): DynamicTool[] {
  return mcpTools.map(tool => new DynamicTool({
    name: tool.name,
    description: tool.description,
    func: async (input: string) => {
      return await tool.execute(JSON.parse(input));
    },
  }));
}
```

## Configuration

### .env file
```bash
# LLM Configuration
OPENAI_API_KEY=sk-...
MODEL_NAME=gpt-4o

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
2. MyAgent routes to LangChain client
3. AgentExecutor processes with tools
4. Memory updated
5. Response returned
```

## Dependencies

```json
{
  "dependencies": {
    "langchain": "^0.2.0",
    "@langchain/openai": "^0.2.0",
    "@langchain/core": "^0.2.0",
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

1. **Chain Types**: LCEL chains, RetrievalQA, etc.
2. **Memory Types**: Buffer, Summary, Vector
3. **LangChain Tools**: Custom tool implementations
4. **Callbacks**: LangChain callback handlers
