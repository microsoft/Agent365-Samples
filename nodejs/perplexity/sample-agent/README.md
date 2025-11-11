# Agent Sample - Perplexity AI

This directory contains a sample agent implementation using Node.js and Perplexity AI.

## Demonstrates

This sample demonstrates how to build an agent using the Agent 365 framework with Node.js and Perplexity AI.

## Prerequisites

- Node.js 18+
- Perplexity AI API Key from <https://perplexity.ai/account/api>
- Agents SDK

## How to run this sample

### 1. Setup environment variables

Copy the template and fill in your values:

```powershell
# Copy the template environment file
cp .env.template .env
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

See `.env.template` for all available options.

### 2. Install Dependencies

```powershell
npm install
```

### 3. Build the Sample

```powershell
npm run build
```

### 4. Start the agent

```powershell
npm start
```

You should see:

```powershell
🚀 Perplexity Agent listening on port 3978
   App ID: your-app-id
   Debug: false

✅ Agent ready to receive messages!
```

### 5. To test with M365 Agents Playground

In a new terminal:

```powershell
npm run test-tool
```

This opens the M365 Agents Playground where you can:

- Chat with your agent
- Test installation flow
- Try notification handling
- Inspect requests/responses

### 5. Optionally, while testing you can run in dev mode (auto-reload)

```powershell
npm run dev
```

This watches for file changes and auto-restarts the server.

The agent will start and be ready to receive requests through the configured hosting mechanism.
