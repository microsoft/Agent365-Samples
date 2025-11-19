# Claude Agent SDK + Microsoft 365 Agents SDK Quickstart

A sample integration demonstrating how to build an intelligent agent using the Claude Agent SDK within the Microsoft 365 Agents SDK.

## Overview

This project combines two powerful SDKs:
- **Claude Agent SDK** - Provides AI agent capabilities powered by Anthropic's Claude models
- **Microsoft 365 Agents SDK** - Enables deployment and hosting of agents within the Microsoft 365 ecosystem

## Architecture

```
User Message → M365 Agent SDK → Claude Agent SDK → Claude AI → Response
```

The agent receives messages through the M365 Agents SDK, processes them using Claude's Agent SDK, and returns intelligent responses.

## Key Features

- **TypeScript/ESM** - Modern ES module syntax with full type safety
- **Agentic AI** - Claude Sonnet 4.5 with tool use capabilities (WebSearch, WebFetch)
- **Express Hosting** - HTTP server for agent communication
- **State Management** - Conversation state tracking with MemoryStorage
- **Error Handling** - Graceful error management and user feedback

## Project Structure

```
src/
├── client.ts   # Claude Agent SDK client wrapper
└── index.ts    # M365 Agent SDK application & server
```

## Prerequisites

- Node.js 16+
- Anthropic API key ([Get one here](https://console.anthropic.com/))

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.template .env
   # Edit .env and add your ANTHROPIC_API_KEY
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

## Running the Agent

**Start the server:**
```bash
npm start
```

**Test with M365 Agents Playground:**
```bash
npm test
```

This runs the agent and playground in parallel for interactive testing.

## Configuration

### Claude Agent Defaults

Located in `src/client.ts`:
- **Model:** Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`)
- **Permission Mode:** Default (prompts for tool usage)
- **Max Turns:** 15 conversation turns
- **Continue Mode:** Enabled for context continuity

### Custom Options

Override defaults in `src/index.ts`:
```typescript
await claudeClient.invokeAgent(userMessage, {
  model: 'claude-3-5-sonnet-20241022',
  allowedTools: ['WebSearch', 'Read', 'Bash'],
  maxTurns: 25
});
```

## Development

**Watch mode (auto-compile):**
```bash
npx tsc --watch
```

**Run without building:**
```bash
npm run start:anon
```

## Documentation

- [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/typescript)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/)

## License

MIT
