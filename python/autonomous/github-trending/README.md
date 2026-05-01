# Autonomous Agent — Python Sample

This sample demonstrates a **purely autonomous agent** built with the Microsoft Agent 365 SDK for Python. It has **no chat functionality** — it runs entirely as a background service.

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
| Autonomous background service with LLM tool calling | `github_trending_service.py` |
| GitHub Search API tool with observability | `tools/github_trending_tool.py` |
| Azure OpenAI chat completions with function calling | `github_trending_service.py` |
| A365 observability with manual tracing scopes | `github_trending_service.py`, `tools/github_trending_tool.py` |
| Microsoft OpenTelemetry distro with S2S exporter | `main.py` |
| 3-hop FMI/FIC token flow for observability export | `observability_token_service.py` |

## Prerequisites

- Python 3.11 or higher
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) (install: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`)
- An Azure OpenAI resource with a deployed model (e.g., `gpt-4o`)
- An Entra tenant with at minimum the **Agent ID Developer** role

## Environment Configuration

### Agent 365 Setup

1. Log in to Azure: `az login`
2. Provision the agent:

```bash
cd python/autonomous/github-trending
a365 setup all --agent-name <your-agent-name>
```

This creates the blueprint, agent identity, configures observability permissions, and writes provisioned values. Copy the output values into your `.env` file (see below).

3. If required, have a Global Admin grant admin consent:

```bash
a365 setup permissions custom --agent-name <your-agent-name> --resource-app-id 9b975845-388f-4429-889e-eab1ef63949c --scopes Agent365.Observability.OtelWrite
```

### Configuration

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
| `AGENT365_USE_MANAGED_IDENTITY` | Manual | `true` for production (MSI), `false` for local dev |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Manual | `true` to enable the A365 span exporter. Required for exporting traces to the A365 observability endpoint. |
| `ENABLE_A365_OBSERVABILITY` | Manual | `true` to enable SDK scope spans (`InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`). Required for the Python SDK. |

### GitHub Trending Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TRENDING_LANGUAGE` | Programming language filter | `python` |
| `GITHUB_TRENDING_MIN_STARS` | Minimum star count | `5` |
| `GITHUB_TRENDING_MAX_RESULTS` | Number of repositories per digest | `10` |
| `HEARTBEAT_INTERVAL_MS` | Polling interval in milliseconds | `60000` |

The GitHub Search API is unauthenticated — no API key required (rate limit: 10 requests/minute).

## Running the Agent Locally

### Quick start (Azure OpenAI only)

You can run the agent with **just Azure OpenAI credentials** — no Agent 365 setup required. Create a minimal `.env`:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

Then:

```bash
cd python/autonomous/github-trending
pip install -e .   # or: uv pip install -e .
python main.py
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
cd python/autonomous/github-trending
cp .env.template .env   # then fill in the values from a365 setup all
pip install -e .         # or: uv pip install -e .
python main.py
```

The agent starts on `http://localhost:3979`. Console output shows:
- **Observability token registration** on startup
- **Trending digest** immediately, then every 60 seconds
- **Heartbeat** log every 60 seconds

## Deploying the Agent

Deploy to your hosting provider and ensure:

1. **Managed Identity is enabled** on the hosting resource — the MSI must have a Federated Identity Credential (FIC) configured against the blueprint app
2. All `AGENT365_*` environment variables are set (except `AGENT365_CLIENT_SECRET`, which is only needed if MSI is unavailable)
3. `AGENT365_USE_MANAGED_IDENTITY` can be omitted — it **defaults to `true`**, so the token service uses MSI automatically
4. `ENABLE_A365_OBSERVABILITY=true` and `ENABLE_A365_OBSERVABILITY_EXPORTER=true` must be set for observability spans and export
5. The 3-hop FMI chain in production: MSI → Blueprint FIC (`fmi_path`) → Agent Identity → Observability API token

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
  Blueprint ConfidentialClient + ClientSecret + fmi_path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> AcquireTokenForClient("api://9b975845-.../.default")
      -> Observability API token

Production (MSI):
  MSI -> ManagedIdentityCredential.get_token("api://AzureADTokenExchange")
      -> Blueprint ConfidentialClient + assertion + fmi_path(agentId)
      -> T1 token (targeted at Agent Identity)
      -> Agent Identity ConfidentialClient + T1 as assertion
      -> Observability API token
```

The token is refreshed every 50 minutes and cached in `token_cache.py`.

For more details, see [Agent observability — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
