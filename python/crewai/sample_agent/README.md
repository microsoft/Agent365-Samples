# CrewAI Agent Sample - Python

This sample demonstrates how to build a multi-agent system using CrewAI while integrating with the Microsoft Agent 365 SDK. It mirrors the structure and hosting patterns of the AgentFramework/OpenAI Agent 365 samples, while preserving native CrewAI logic in `src/crew_agent/`.

## Demonstrates

- **MCP Tooling**: Full Model Context Protocol (MCP) integration with Microsoft 365 services (Mail, Calendar, Copilot)
- **Observability**: Complete tracing with `InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` for all agent operations
- **Notifications**: Email and Teams @mention notification support
- **Multi-Agent Orchestration**: Sequential agent workflow with Weather Checker and Driving Safety Advisor agents
- **Azure OpenAI Integration**: Native support for Azure OpenAI deployments with LiteLLM
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11+
- [UV](https://docs.astral.sh/uv/) (recommended for dependency management)
- Azure OpenAI API credentials OR OpenAI API key
- [Tavily API key](https://tavily.com) for weather search functionality
- Microsoft 365 Agents Playground (optional, for testing)
- Bearer token from `a365 develop get-token -o raw` (for MCP server authentication)

## Configuration

### Step 1: Create Environment File

Copy `.env.template` to `.env`:

```bash
cp .env.template .env
```

### Step 2: Configure Required Variables

**For Azure OpenAI (recommended):**
```env
AZURE_API_KEY=your-azure-openai-key
AZURE_API_BASE=https://your-resource.openai.azure.com/
AZURE_API_VERSION=2025-01-01-preview
OPENAI_API_KEY=your-azure-openai-key  # CrewAI requires this
OPENAI_MODEL_NAME=azure/gpt-4.1       # Use azure/ prefix for LiteLLM
```

**For OpenAI:**
```env
OPENAI_API_KEY=sk-your-openai-key
OPENAI_MODEL_NAME=gpt-4o-mini
```

**For MCP Tools (Mail, Calendar, Copilot):**
```env
BEARER_TOKEN=<run: a365 develop get-token -o raw>
USE_AGENTIC_AUTH=false
AGENTIC_APP_ID=crewai-agent
```

**For Weather Tool:**
```env
TAVILY_API_KEY=tvly-your-tavily-key
```

## Running the Agent

### Option 1: Run via Agent Runner (Standalone)

```bash
uv run python -m crew_agent.agent_runner "London"
# or
uv run agent_runner "San Francisco, CA"
```

### Option 2: Hosted via Generic Agent Host (Recommended)

This option integrates with Microsoft 365 Agents SDK for full observability and MCP tooling.

1. Ensure `.env` is configured (see above)

2. Get a bearer token for MCP authentication:
   ```bash
   a365 develop get-token -o raw
   ```
   Copy the token to `BEARER_TOKEN` in `.env`

3. Start the agent host:
   ```bash
   uv run python start_with_generic_host.py
   ```

4. Test endpoints:
   - Health check: `http://localhost:3978/api/health`
   - Bot Framework: `http://localhost:3978/api/messages`

5. Connect with Agents Playground:
   ```bash
   agentsplayground -e "http://localhost:3978/api/messages" -c "emulator"
   ```

### Example Prompts

```
Find weather in Dublin and email the information to user@example.com under the subject "Weather Report"
```

```
What's the weather in Seattle? Is it safe to drive with summer tires?
```

## Architecture

### Agent Workflow

```
┌─────────────────────────┐     ┌──────────────────────────┐
│  Weather Information    │────▶│  Driving Safety          │
│  Specialist             │     │  Specialist              │
│  (Tavily + MCP Tools)   │     │  (MCP Tools only)        │
└─────────────────────────┘     └──────────────────────────┘
         │                                │
         ▼                                ▼
   Weather Report              Safety Assessment + Email
```

### MCP Tools Available

When connected with a valid bearer token, the following MCP servers are available:

| Server | Tools | Description |
|--------|-------|-------------|
| `mcp_MailTools` | 20 tools | Send/receive emails, manage drafts, attachments |
| `mcp_CalendarTools` | 12 tools | Create/manage events, check availability |
| `mcp_M365Copilot` | 1 tool | Query Microsoft 365 Copilot |

### Observability Scopes

All agent operations are traced with Agent 365 observability:

- **InvokeAgentScope**: Wraps the entire agent invocation
- **InferenceScope**: Wraps LLM calls (CrewAI crew execution)
- **ExecuteToolScope**: Wraps each MCP tool execution

## File Structure

```
sample_agent/
├── .env.template              # Environment template with documentation
├── start_with_generic_host.py # Main entry point
├── host_agent_server.py       # Agent 365 SDK hosting
├── agent.py                   # CrewAI agent wrapper with observability
├── observability_config.py    # Observability setup
├── token_cache.py             # Bearer token caching
├── turn_context_utils.py      # Turn context utilities
├── ToolingManifest.json       # MCP server definitions
└── src/crew_agent/
    ├── config/
    │   ├── agents.yaml        # Agent definitions
    │   └── tasks.yaml         # Task definitions
    ├── crew.py                # CrewAI crew orchestration
    └── tools/
        └── custom_tool.py     # WeatherTool (Tavily)
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `No MCP tools discovered` | Ensure `BEARER_TOKEN` is set and not expired. Run `a365 develop get-token -o raw` |
| `Weather tool returns no data` | Set `TAVILY_API_KEY` in `.env` |
| `Azure OpenAI 401 error` | Verify `AZURE_API_KEY` and `AZURE_API_BASE` are correct |
| `Duplicate emails sent` | Update `tasks.yaml` - only Driving Safety agent should send emails |
| `CrewAI tracing 401` | This is a warning from CrewAI cloud tracing; local observability still works |

### Logs to Check

```
INFO:agent:✅ 33 MCP tool(s) available:        # MCP connected successfully
INFO:agent:📊 Created observable wrapper       # Tool wrappers with ExecuteToolScope
INFO:agent:🔧 Calling MCP tool: SendEmail...   # Tool execution
```

## Support

For issues, questions, or feedback:

- **CrewAI Documentation**: https://docs.crewai.com
- **CrewAI GitHub**: https://github.com/joaomdmoura/crewai
- **Microsoft Agent 365 Documentation**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/
- **Discord**: https://discord.com/invite/X4JWnZnxPb

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [CrewAI API documentation](https://docs.crewai.com)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.