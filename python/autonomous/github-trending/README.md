# Autonomous GitHub Trending Agent — Python Sample

## Overview

This sample demonstrates a **purely autonomous agent** built with the Microsoft Agent 365 SDK for Python. It has **no chat functionality** — it runs entirely as a background service.

Every 60 seconds, the agent:

1. Prompts Azure OpenAI to fetch trending GitHub repositories using a registered tool
2. The model calls the `get_trending_repositories` tool, which queries the GitHub Search API
3. The model summarizes the results into a readable digest
4. The digest is logged to the console

All operations are **manually instrumented** with Agent 365 observability using the A365 Observability SDK tracing scopes (`InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`). This makes it a useful reference for instrumenting any non-interactive or custom agent loop.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11 or higher
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
cd python/autonomous/agent-framework/github-trending
a365 setup all --agent-name <your-agent-name>
```

This creates the blueprint, agent identity, configures observability permissions, and writes provisioned values. Copy the output values into your `.env` file (see below).

### 4. Admin consent (if required)

```bash
a365 setup admin --blueprint-id <blueprint-id>
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

### Local development

The `.env` file sets `AGENT365_USE_MANAGED_IDENTITY=false`, which tells the token service to authenticate using the blueprint's client secret instead of Managed Identity. This is the only auth difference between local dev and production — all other behavior is identical.

```bash
cd python/autonomous/agent-framework/github-trending
cp .env.template .env   # then fill in the values from a365 setup all
pip install -e .         # or: uv pip install -e .
python main.py
```

The agent starts on `http://localhost:3979`. Console output shows:
- **Observability token registration** on startup
- **Trending digest** immediately, then every 60 seconds
- **Heartbeat** log every 60 seconds

### Production

Deploy to your hosting provider and ensure:

1. **Managed Identity is enabled** on the hosting resource — the MSI must have a Federated Identity Credential (FIC) configured against the blueprint app
2. All `AGENT365_*` environment variables are set (except `AGENT365_CLIENT_SECRET`, which is only needed if MSI is unavailable)
3. `AGENT365_USE_MANAGED_IDENTITY` can be omitted — it **defaults to `true`**, so the token service uses MSI automatically
4. The 3-hop FMI chain in production: MSI → Blueprint FIC (`fmi_path`) → Agent Identity → Observability API token

## Observability Architecture

### Tracing spans

Each autonomous cycle produces three nested spans:

```
InvokeAgentScope                        (root — wraps the entire cycle)
  |-- InferenceScope                    (child — wraps the LLM call)
  |-- ExecuteToolScope                  (child — wraps the GitHub API tool call)
```

### Token flow — 3-hop FMI chain

The `observability_token_service.py` background task acquires tokens using:

```
Local dev (client secret):
  Blueprint ConfidentialClient + ClientSecret + FMI path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> AcquireTokenForClient("api://9b975845-.../.default")
      -> Observability API token

Production (MSI):
  MSI -> ManagedIdentityCredential.get_token("api://AzureADTokenExchange")
      -> Blueprint ConfidentialClient + assertion + FMI path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> Observability API token
```

The token is refreshed every 50 minutes and cached in `token_cache.py`.

For more details, see [Agent observability — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## Project Structure

```
github-trending/
  main.py                              # Entry point — distro init, background tasks, health server
  github_trending_service.py           # Autonomous background service (InvokeAgent + Inference spans)
  observability_token_service.py       # Background FMI token acquisition service
  token_cache.py                       # In-memory token cache
  tools/
    github_trending_tool.py            # GitHub Search API tool (ExecuteTool span)
  .env.template                        # Environment variable template
  pyproject.toml                       # Package metadata and dependencies
  README.md                            # This file
```

## GitHub Trending Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TRENDING_LANGUAGE` | Programming language filter | `python` |
| `GITHUB_TRENDING_MIN_STARS` | Minimum star count | `5` |
| `GITHUB_TRENDING_MAX_RESULTS` | Number of repositories per digest | `10` |
| `HEARTBEAT_INTERVAL_MS` | Polling interval in milliseconds | `60000` |

The GitHub Search API is unauthenticated — no API key required (rate limit: 10 requests/minute).

## Support

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
- **Documentation**: [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
