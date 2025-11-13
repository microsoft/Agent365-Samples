# Agent Code Walkthrough

Step-by-step walkthrough of the implementation in `src/agent.ts`.
This is a quickstart starting point for building a LangChain agent with the Microsoft 365 Agents SDK.

## Overview

| Component | Purpose |
|-----------|---------|
| **LangChain** | Core AI orchestration framework |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |

## File Structure and Organization

```
quickstart-before/
├── src/
│   ├── agent.ts               # Main agent implementation
│   ├── client.ts              # LangChain client wrapper
│   └── index.ts               # Express server entry point
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript configuration
└── .env                       # Configuration (not committed)
```

---

---

## Step 1: Dependency Imports

### agent.ts imports:
```typescript
import { TurnState, AgentApplication, TurnContext } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
```

### client.ts imports:
```typescript
import { createAgent, ReactAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **@microsoft/agents-hosting**: Bot Framework integration for hosting and turn management
- **@microsoft/agents-activity**: Activity types for different message formats
- **langchain**: LangChain framework for building AI agents
- **@langchain/openai**: OpenAI chat model integration for LangChain

---

## Step 2: Agent Initialization

```typescript
class MyAgent extends AgentApplication<TurnState> {
  constructor() {
    super();

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });
  }
}
```

**What it does**: Creates the main AI agent and sets up its basic behavior.

**What happens**:
1. **Extends AgentApplication**: Inherits Bot Framework hosting capabilities
2. **Event Routing**: Registers a handler for incoming messages

---

## Step 3: Agent Creation

The agent client wrapper is defined in `client.ts`:

```typescript
export async function getClient(): Promise<Client> {
  // Create the model
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
  });

  // Create the agent
  const agent = createAgent({
    model: model,
    tools: [],
    name: 'My Custom Agent',
  });

  return new LangChainClient(agent);
}
```

**What it does**: Creates a LangChain React agent with an OpenAI model.

**What happens**:
1. **Model Creation**: Initializes ChatOpenAI with the specified model (gpt-4o-mini)
2. **Agent Creation**: Creates a React agent with the model and tools
3. **Returns Client**: Wraps the agent in a client interface

---

## Step 4: Message Processing

```typescript
async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
  const userMessage = turnContext.activity.text?.trim() || '';

  if (!userMessage) {
    await turnContext.sendActivity('Please send me a message and I\'ll help you!');
    return;
  }

  try {
    const client: Client = await getClient();
    const response = await client.invokeAgent(userMessage);
    await turnContext.sendActivity(response);
  } catch (error) {
    console.error('LLM query error:', error);
    const err = error as any;
    await turnContext.sendActivity(`Error: ${err.message || err}`);
  }
}
```

**What it does**: Handles regular chat messages from users.

**What happens**:
1. **Extract Message**: Gets the user's text from the activity
2. **Validate Input**: Checks for non-empty message
3. **Create Client**: Gets LangChain client
4. **Invoke Agent**: Calls agent with user message
5. **Send Response**: Returns AI-generated response to user
6. **Error Handling**: Catches problems and returns friendly error messages
---

## Step 5: Agent Invocation

Agent invocation is handled in `client.ts`:

```typescript
async invokeAgent(userMessage: string): Promise<string> {
  const result = await this.agent.invoke({
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  let agentMessage: any = '';

  // Extract the content from the LangChain response
  if (result.messages && result.messages.length > 0) {
    const lastMessage = result.messages[result.messages.length - 1];
    agentMessage = lastMessage.content || "No content in response";
  }

  // Fallback if result is already a string
  if (typeof result === 'string') {
    agentMessage = result;
  }

  if (!agentMessage) {
    return "Sorry, I couldn't get a response from the agent :(";
  }

  return agentMessage;
}
```

**What it does**: Invokes the LangChain agent with the user's message and extracts the response.

**What happens**:
1. **Invoke Agent**: Calls the LangChain agent with the user message
2. **Extract Response**: Gets the agent's response from the result
3. **Handle Fallbacks**: Returns a friendly message if no response is available
4. **Return Result**: Returns the agent's response as a string
---

## Step 6: Main Entry Point

The main entry point is in `index.ts`:

```typescript
import { configDotenv } from 'dotenv';

configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

const authConfig: AuthConfiguration = {};

const server = express()
server.use(express.json())
server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = process.env.PORT || 3978
server.listen(port, async () => {
  console.log(`\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
})
```

**What it does**: Starts the HTTP server and sets up Bot Framework integration.

**What happens**:
1. **Load Environment**: Reads .env file before importing other modules
2. **Create Express Server**: Sets up HTTP server with JSON parsing
3. **JWT Authorization**: Adds authentication middleware
4. **Bot Framework Endpoint**: Creates /api/messages endpoint for Bot Framework
5. **Start Server**: Listens on configured port (default 3978)

**Why it's useful**: This is the entry point that makes your agent accessible via HTTP!
---

## Design Patterns and Best Practices

### 1. **Factory Pattern**

Clean client creation through factory function:

```typescript
const client = await getClient();
```

### 2. **Event-Driven Architecture**

Bot Framework event routing:

```typescript
this.onActivity(ActivityTypes.Message, async (context, state) => {
  await this.handleAgentMessageActivity(context, state);
});
```

---

## Extension Points

### 1. **Adding Tools**

Extend the agent with LangChain tools:

```typescript
const agent = createAgent({
  model: model,
  tools: [myCustomTool],
  name: 'My Custom Agent',
});
```

### 2. **Customizing the Model**

Change model parameters:

```typescript
const model = new ChatOpenAI({
  model: "gpt-4o",
  temperature: 0.7,
});
```

---

## Performance Considerations

### 1. **Async Operations**
- All I/O operations are asynchronous
- Proper promise handling throughout

### 2. **Error Recovery**
- User-friendly error messages
- Comprehensive error logging

---

## Debugging Guide

### 1. **Enable Debug Logging**

Set DEBUG environment variable:

```bash
DEBUG=*
```

### 2. **Test Agent Response**

Check agent invocation:

```typescript
console.log('Agent response:', response);
```

This architecture provides a solid foundation for building AI agents with LangChain while maintaining flexibility for customization and extension.