# Perplexity AI Agent Sample

A complete Microsoft 365 Agent powered by Perplexity AI, built with the Agent365 SDK.

## Features

- ✅ **Chat with Perplexity** - Natural language conversations using Perplexity's Sonar models
- ✅ **M365 Integration** - Works with Microsoft Teams, Outlook, and other M365 apps
- ✅ **Notification Handling** - Responds to emails and Word @mentions
- ✅ **Observability** - Built-in tracing and monitoring with Kairo
- ✅ **MCP Tools** - Access to Mail, Calendar, SharePoint, and OneDrive tools

## Architecture

This sample follows the Agent365 scaffolding pattern:
- **index.ts** - Express server + Bot Framework adapter
- **agent.ts** - Activity routing (messages, notifications, installation)
- **perplexityAgent.ts** - Business logic and orchestration
- **perplexityClient.ts** - Perplexity SDK integration with observability
- **telemetry.ts** - Kairo observability configuration

See [SCAFFOLDING_GUIDE.md](./SCAFFOLDING_GUIDE.md) for detailed architecture explanation.

## Prerequisites

- Node.js 18+
- A Perplexity API Key: https://perplexity.ai/account/api
- Agent365 SDK built locally (see [Installation](#installation))

## Installation

### 1. Build Agent365 SDK

First, build the local Agent365 SDK packages:

```powershell
cd c:\365\Agent365\nodejs\src
npm install
npm run build:all
```

This creates `.tgz` files in `c:\365\Agent365\nodejs\`.

### 2. Install Sample Dependencies

```powershell
cd c:\365\Agent365\nodejs\samples\perplexity-ai-sdk
npm install
```

### 3. Build the Sample

```powershell
npm run build
```

## Configuration

### Create .env File

Copy the example and fill in your values:

```powershell
cp .env.example .env
```

**Minimum required:**
```bash
PERPLEXITY_API_KEY=your_perplexity_api_key_here
AGENT_ID=perplexity-agent
PORT=3978
```

**For production/M365 integration, also add:**
```bash
CLIENT_ID=your_bot_app_id
CLIENT_SECRET=your_bot_secret
TENANT_ID=your_tenant_id
```

See `.env.example` for all available options.

## Running the Agent

### Start the Agent Server

```powershell
npm start
```

You should see:
```
🚀 Perplexity Agent listening on port 3978
   App ID: your-app-id
   Debug: false

✅ Agent ready to receive messages!
```

### Test with M365 Agents Playground

In a new terminal:

```powershell
npm run test-tool
```

This opens the M365 Agents Playground where you can:
- Chat with your agent
- Test installation flow
- Try notification handling
- Inspect requests/responses

### Development Mode (Auto-reload)

```powershell
npm run dev
```

This watches for file changes and auto-restarts the server.

## Usage Examples

### Basic Chat

1. Start the agent with `npm start`
2. Open playground with `npm run test-tool`
3. Click "Install" to install the agent
4. Type "I accept" to accept terms
5. Chat: "What is the latest news about AI?"

### Testing Notifications

The agent can handle:
- **Email notifications** - Forward emails to the agent
- **Word @mentions** - Mention the agent in Word comments
- **Custom notifications** - See `perplexityAgent.ts` for handlers

### Changing Perplexity Model

Edit `.env`:
```bash
PERPLEXITY_MODEL=sonar-pro  # Options: sonar, sonar-pro, etc.
```

## Project Structure

```
perplexity-ai-sdk/
├── src/
│   ├── index.ts              # Express server + Bot Framework
│   ├── agent.ts              # Activity routing
│   ├── perplexityAgent.ts    # Business logic
│   ├── perplexityClient.ts   # Perplexity SDK integration
│   └── telemetry.ts          # Observability config
├── ToolingManifest.json      # MCP tools configuration
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Troubleshooting

Having issues with npm installation or running the sample? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and solutions.


