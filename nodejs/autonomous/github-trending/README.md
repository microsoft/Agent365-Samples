# Autonomous GitHub Trending Agent — Node.js Sample

## Overview

This sample demonstrates a **purely autonomous agent** built with the Microsoft Agent 365 SDK for Node.js/TypeScript. It has **no chat functionality** — it runs entirely as a background service.

Every 60 seconds, the agent:

1. Prompts Azure OpenAI to fetch trending GitHub repositories using a registered tool
2. The model calls the `get_trending_repositories` tool, which queries the GitHub Search API
3. The model summarizes the results into a readable digest
4. The digest is logged to the console

All operations are **manually instrumented** with Agent 365 observability using the A365 Observability SDK tracing scopes (`InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`). This makes it a useful reference for instrumenting any non-interactive or custom agent loop.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Autonomous background service with LLM tool calling | `src/github-trending-service.ts` |
| GitHub Search API tool with observability | `src/tools/github-trending-tool.ts` |
| Azure OpenAI chat completions with function calling | `src/github-trending-service.ts` |
| A365 observability with manual tracing scopes | `src/github-trending-service.ts`, `src/tools/github-trending-tool.ts` |
| ObservabilityManager configuration with token resolver | `src/index.ts` |
| 3-hop FMI/FIC token flow for observability export | `src/observability-token-service.ts` |
| Periodic heartbeat service | `src/heartbeat-service.ts` |

## Prerequisites

- [Node.js 18](https://nodejs.org/) or higher
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli)
- An Azure OpenAI resource with a deployed model (e.g., `gpt-4o`)
- An Entra tenant with at minimum the **Agent ID Developer** role

## Agent 365 Setup

### 1. Install the Agent 365 CLI

```bash
dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease
```

### 2. Log in to Azure

```bash
az login
```

### 3. Provision the agent

```bash
cd nodejs/autonomous/github-trending
a365 setup all --agent-name <your-agent-name>
```

This creates the blueprint, agent identity, configures observability permissions, and writes provisioned values. Copy the output values into your `.env` file (see below).

### 4. Admin consent (if required)

```bash
a365 setup admin --blueprint-id <blueprint-id>
```

### 5. Configure Azure OpenAI

The CLI does not configure Azure OpenAI settings. Set these manually in your `.env` file:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

## Configuration

Copy `.env.template` to `.env` and fill in the values from `a365 setup all` output:

```bash
cp .env.template .env
```

| Variable | Set by | Description |
|----------|--------|-------------|
| `AZURE_OPENAI_ENDPOINT` | Manual | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_KEY` | Manual | Azure OpenAI API key |
| `AZURE_OPENAI_DEPLOYMENT` | Manual | Model deployment name (default: `gpt-4o`) |
| `AGENT365_TENANT_ID` | CLI | Entra tenant ID |
| `AGENT365_AGENT_ID` | CLI | Agent identity ID (separate from blueprint) |
| `AGENT365_BLUEPRINT_ID` | CLI | Blueprint app registration ID |
| `AGENT365_CLIENT_ID` | CLI | Blueprint app ID (same as blueprint ID) |
| `AGENT365_CLIENT_SECRET` | CLI | Blueprint client secret |
| `AGENT365_AGENT_NAME` | CLI | Display name shown in traces |
| `AGENT365_AGENT_DESCRIPTION` | CLI | Agent description shown in traces |
| `AGENT365_USE_MANAGED_IDENTITY` | Manual | `true` for production (MSI), `false` for local dev. **Defaults to `true` when unset.** |

## Running the Agent

### Quick start (Azure OpenAI only)

You can run the agent with **just Azure OpenAI credentials** — no Agent 365 setup required. Create a minimal `.env`:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AGENT365_USE_MANAGED_IDENTITY=false
NODE_ENV=development
```

Then:

```bash
cd nodejs/autonomous/github-trending
npm install
npm run dev
```

The agent will skip the observability token service and log a warning:

```
Agent365 credentials not configured — skipping token service.
Run 'a365 setup all' to enable A365 observability export.
```

To enable full A365 observability, complete the [Agent 365 Setup](#agent-365-setup) steps and fill in the remaining `.env` values.

### Local development (with A365 observability)

Copy `.env.template` to `.env` and fill in all values from `a365 setup all`. The template sets `AGENT365_USE_MANAGED_IDENTITY=false`, which tells the token service to authenticate using the blueprint's client secret instead of Managed Identity.

```bash
cd nodejs/autonomous/github-trending
cp .env.template .env   # then fill in the values from a365 setup all
npm install
npm run dev
```

The agent starts on `http://localhost:3979`. Console output shows:
- **Observability token registration** on startup
- **Trending digest** immediately, then every 60 seconds
- **Heartbeat** log every 60 seconds

### Production

Build and run:

```bash
npm run build
npm start
```

Deploy to your hosting provider and ensure:

1. **Managed Identity is enabled** on the hosting resource — the MSI must have a Federated Identity Credential (FIC) configured against the blueprint app
2. All `AGENT365_*` environment variables are set (except `AGENT365_CLIENT_SECRET`, which is only needed if MSI is unavailable)
3. `AGENT365_USE_MANAGED_IDENTITY` can be omitted — it **defaults to `true`**, so the token service uses MSI automatically
4. The 3-hop FMI chain in production: MSI -> Blueprint FIC (`fmiPath`) -> Agent Identity -> Observability API token

## Observability Architecture

### Tracing spans

Each autonomous cycle produces three nested spans:

```
InvokeAgentScope                        (root — wraps the entire cycle)
  |-- InferenceScope                    (child — wraps the LLM call)
  |-- ExecuteToolScope                  (child — wraps the GitHub API tool call)
```

### Token flow — 3-hop FMI chain

The `observability-token-service.ts` background task acquires tokens using:

```
Local dev (client secret):
  Blueprint ConfidentialClient + ClientSecret + FMI path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> AcquireTokenForClient("api://9b975845-.../.default")
      -> Observability API token

Production (MSI):
  MSI -> ManagedIdentityCredential.getToken("api://AzureADTokenExchange")
      -> Blueprint ConfidentialClient + assertion + FMI path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> Observability API token
```

The token is refreshed every 50 minutes and cached in `token-cache.ts`.

For more details, see [Agent observability — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## How It Works

```
+---------------------------------+
|   GitHubTrendingService         |
|   (Background interval)        |
|                                 |
|  1. Timer fires                 |
|  2. InvokeAgentScope started    |
|  3. Send prompt to AzureOpenAI  |
|     with tool registered        |
|                                 |
|  +---------------------------+  |
|  | Azure OpenAI (ChatAPI)    |  |
|  | InferenceScope started    |  |
|  |                           |  |
|  |  4. Model calls           |  |
|  |     get_trending_repos    |  |
|  |                           |  |
|  |  +---------------------+  |  |
|  |  | github-trending-tool|  |  |
|  |  | ExecuteToolScope    |  |  |
|  |  |                     |  |  |
|  |  | 5. GET github.com/  |  |  |
|  |  |    search/repos     |  |  |
|  |  +---------------------+  |  |
|  |                           |  |
|  |  6. Model summarizes      |  |
|  |     results into digest   |  |
|  +---------------------------+  |
|                                 |
|  7. Log digest to console       |
|  8. Spans exported to A365      |
+---------------------------------+
```

## GitHub Trending Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TRENDING_LANGUAGE` | Programming language filter | `typescript` |
| `GITHUB_TRENDING_MIN_STARS` | Minimum star count | `5` |
| `GITHUB_TRENDING_MAX_RESULTS` | Number of repositories per digest | `10` |
| `HEARTBEAT_INTERVAL_MS` | Polling interval in milliseconds | `60000` |

The GitHub Search API is unauthenticated — no API key required (rate limit: 10 requests/minute).

## Project Structure

```
github-trending/
  src/
    index.ts                             # Entry point — Express server, distro init, background services
    github-trending-service.ts           # Autonomous background service (InvokeAgent + Inference spans)
    heartbeat-service.ts                 # Periodic heartbeat logger
    observability-token-service.ts       # Background FMI token acquisition service
    token-cache.ts                       # In-memory token cache
    tools/
      github-trending-tool.ts            # GitHub Search API tool (ExecuteTool span)
  .env.template                          # Environment variable template
  package.json                           # Package metadata and dependencies
  tsconfig.json                          # TypeScript configuration
  README.md                              # This file
```

## Support

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
- **Documentation**: [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA). For details, visit <https://cla.opensource.microsoft.com>.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
