---
name: generate-readme
description: >
  Generates or updates a README.md for an Agent 365 sample agent. Detects the agent type
  (interactive or autonomous), programming language (.NET, Node.js, Python), and authentication
  model, then produces a README following the standard template with all required sections.
compatibility:
  - claude-code
user-invocable: true
argument-hint: "Optional: path to sample agent directory"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

# Generate README

Generate or update a `README.md` for a sample agent in the Agent365-Samples repository.

## Instructions

1. **Detect the agent** — identify the programming language, orchestrator, and whether it is interactive (message-driven) or autonomous (background service).
2. **Detect authentication + identity model** — determine which combination applies (see table below).
3. **Generate the README** using the exact template structure defined in this skill.
4. **Adapt content** from the existing README if one exists — preserve sample-specific details (tool names, service names, configuration keys) but restructure to match the template.

## README Template

The README MUST contain the following sections in this exact order. Do not add, remove, or reorder sections unless noted.

### 1. Title + Description

```markdown
# <Sample Title> — <Language> Sample

<1–3 sentence description of what the sample demonstrates. State whether it is interactive or autonomous, what SDK/orchestrator it uses, and what makes it a useful reference.>

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).
```

### 2. What This Sample Demonstrates

A table of patterns demonstrated and their file locations:

```markdown
## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| <pattern description> | `<file path>` |
```

### 3. Prerequisites

```markdown
## Prerequisites

- <Runtime/SDK version>
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) (install: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`)
- An Azure OpenAI resource with a deployed model (e.g., `gpt-4o`)
- An Entra tenant with at minimum the **Agent ID Developer** role
- <Any additional prerequisites specific to the sample>
```

### 4. Authentication + Identity

This section describes the authentication and identity model used by the agent. Pick exactly ONE auth model and ONE identity model from the tables below. If it is unclear which model is used from the code/existing README, ask the user.

**Auth models** (pick one):

| Auth Model | Description | When to use |
|------------|-------------|-------------|
| Agent user | The agent authenticates as its own agentic user identity. | AI Teammates with Teams/Copilot chat capabilities. |
| On behalf of the user | The agent acts on behalf of the signed-in user via OBO token exchange. | Interactive or autonomous agents that call resources as the user. |
| App token | The agent authenticates using application credentials with no user context. | Interactive or autonomous agents that call resources as the app. |

**Identity models** (pick one):

| Identity Model | Description | When to use |
|----------------|-------------|-------------|
| Agent user with own identity | The agent has an agentic user account in the tenant. | AI Teammates with Teams/Copilot chat capabilities. |
| Agent identity | The agent has an identity service principal that serves as an instance of the blueprint. | Agent 365 blueprint-based agents that use the Agent identity model (service principal instance of the blueprint). |
| Entra app service principal | The agent authenticates as a standard Entra app registration (no blueprint, no FMI). | Simple agents using direct client credentials without the A365 identity model. |

Write the section as:

```markdown
## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | <one of: Agent user, On behalf of the user, App-based> |
| **Identity** | <one of: Agent user with own identity, Agent identity, Entra app service principal> |

<1–2 sentences explaining how auth works in this specific sample. Reference the relevant code file.>
```

### 5. Environment Configuration

```markdown
## Environment Configuration

### Agent 365 Setup

<Steps to provision the agent using the A365 CLI. Include `a365 setup all`, admin consent, and manual configuration (e.g., Azure OpenAI keys).>

### Configuration

<Configuration reference — either a table of .env variables or appsettings.json keys. Include "Set by" column (CLI or Manual).>
```

For all samples, include `ENABLE_A365_OBSERVABILITY_EXPORTER`, `ENABLE_A365_OBSERVABILITY`, `OTEL_LOG_LEVEL`, and `A365_OBSERVABILITY_LOG_LEVEL` in the configuration table. If they are not set, prompt the user and ask if they would like them to be added. If yes, add them. Default values are `ENABLE_A365_OBSERVABILITY_EXPORTER`=true, `ENABLE_A365_OBSERVABILITY`=true, `A365_OBSERVABILITY_LOG_LEVEL`=info, and `OTEL_LOG_LEVEL`=Debug. `ENABLE_A365_OBSERVABILITY_EXPORTER` is a Python and JavaScript concept. In .NET, the Agent 365 exporter is controlled entirely in code via `ExportTarget.Agent365`. Update this if needed.

### 6. Running the Agent Locally

```markdown
## Running the Agent Locally

### Quick start (Azure OpenAI only)

<Minimal setup — just LLM credentials, no A365.>

### Local development (with A365 observability)

<Full setup with A365 credentials and observability export.>
```

For interactive agents, reference the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing) guide and Microsoft 365 Agents Playground.

### 7. Deploying the Agent

```markdown
## Deploying the Agent

<Production deployment instructions. Include MSI/FIC requirements, environment variables, and hosting provider guidance.>
```

### 8. Observability

```markdown
## Observability

<Describe the tracing spans produced by the agent (e.g., InvokeAgentScope, InferenceScope, ExecuteToolScope). For agents with a custom token flow, describe the FMI chain briefly. Link to the observability guide.>
```

Keep this section concise — no ASCII art diagrams. Reference the [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability) for details.

### 9. Support

```markdown
## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../../SECURITY.md)
```

### 10. Contributing

```markdown
## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
```

### 11. Additional Resources

```markdown
## Additional Resources

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- <Language-specific SDK repository link>
- <Any other relevant links>
```

### 12. Trademarks

```markdown
## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*
```

### 13. License

```markdown
## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
```

Adjust the relative path to `LICENSE.md` based on the sample's depth in the repository.

## Detection Rules

### Programming Language
- `.csproj` file exists → .NET
- `package.json` exists → Node.js/TypeScript
- `pyproject.toml` or `.py` files → Python

### Agent Type
- Has `/api/messages` endpoint, `TurnContext`, `AgentApplication`, or message handler → Interactive
- Has `BackgroundService`, background loop, no message endpoint → Autonomous

### Auth + Identity Detection
- Has `TurnContext` with `Activity.From` + agentic user references → Agent user auth + Agent user with own identity
- Has `exchangeToken` / OBO flow → On behalf of the user
- Has only client credentials / MSI with no user context → App-based auth + Agent identity
- Has `WithFmiPath` / `fmi_path` / FMI chain → Agent identity
- Has simple `ClientSecretCredential` with no FMI → Entra app service principal

## Rules

- Do NOT include How It Works or Project Structure sections.
- Do NOT include ASCII art diagrams.
- Do NOT invent content — only document what exists in the code.
- Do NOT include sample-specific SDK repository links unless you can verify the URL exists.
- ALWAYS read the agent's source code before generating the README.
- If an existing README exists, preserve any sample-specific details that are accurate.
