# Sample Agent - Node.js LangChain

This directory contains a quickstart agent implementation using Node.js and LangChain.

## Demonstrates

This sample is used to demonstrate how to build an agent using the Microsoft Agent 365 SDK with Node.js and LangChain. The sample includes basic LangChain Agent SDK usage hosted with Agents SDK that is testable on [agentsplayground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project?tabs=windows).
Please refer to this [quickstart guide](https://review.learn.microsoft.com/en-us/microsoft-agent-365/developer/quickstart-nodejs-langchain?branch=main) on how to extend your agent using Microsoft Agent 365 SDK.

## Prerequisites

- Node.js 18+
- LangChain
- Agents SDK

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `sendActivity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `sendActivity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `handleAgentMessageActivity` ([agent.ts](src/agent.ts)):

```typescript
// Message 1: immediate ack — reaches the user right away
await turnContext.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await turnContext.sendActivity(response);
```

Each `sendActivity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(async () => {
    await turnContext.sendActivity({ type: 'typing' } as Activity);
  }, 4000);
};
const stopTypingLoop = () => { clearInterval(typingInterval); };

startTypingLoop();
try {
  // ... LLM processing ...
} finally {
  stopTypingLoop();
}
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## How to run this sample

1. **Setup environment variables**
   ```bash
   # Copy the example environment file
   cp .env.template .env
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Start the agent**
   ```bash
   npm start
   ```

5. **Optionally, while testing you can run in dev mode**
   ```bash
   npm run dev
   ```

6. **Start AgentsPlayground to chat with your agent**
   ```bash
   agentsplayground
   ```

The agent will start and be ready to receive requests through the configured hosting mechanism.

## Documentation

For detailed information about this sample, please refer to:

- **[AGENT-CODE-WALKTHROUGH.md](AGENT-CODE-WALKTHROUGH.md)** - Detailed code explanation and architecture walkthrough

## 📚 Related Documentation

- [LangChain Agent SDK Documentation](https://docs.langchain.com/oss/javascript/langchain/overview)
- [Microsoft 365 Agents SDK](https://github.com/microsoft/Agents-for-js/tree/main)
- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/typescript-sdk/tree/main)

## 🤝 Contributing

1. Follow the existing code patterns and structure
2. Add comprehensive logging and error handling
3. Update documentation for new features
4. Test thoroughly with different authentication methods

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.