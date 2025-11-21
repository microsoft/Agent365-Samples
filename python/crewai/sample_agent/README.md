# CrewAgent Crew

Welcome to the CrewAgent Crew project, powered by [crewAI](https://crewai.com). This template is designed to help you set up a multi-agent AI system with ease. The sample now mirrors the AgentFramework/OpenAI Agent 365 patterns while keeping the CrewAI logic in `src/crew_agent` unchanged.

## Installation

Ensure you have Python >=3.11 installed. This project uses [UV](https://docs.astral.sh/uv/) for dependency management.

```bash
pip install uv
uv sync   # or: python -m pip install -e .
```

## Customizing
- Add your `OPENAI_API_KEY` into `.env`.
- Modify `src/crew_agent/config/agents.yaml` and `tasks.yaml`.
- Edit `src/crew_agent/crew.py` and `src/crew_agent/main.py` for your logic.

## Running the Project

### Option 1: Run CrewAI Directly
```bash
crewai run
```

### Option 2: Run via Agent Runner
```bash
python -m crew_agent.agent_runner "London"
# or
agent_runner "San Francisco, CA"
```

### Option 3: Hosted via Generic Agent Host with Agent 365 (Microsoft Agent365 SDK)
Mirrors the OpenAI/AgentFramework samples and adds Agent 365 observability + MCP server registration.

1) Copy `.env.template` to `.env` and fill:
   - `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` / `CLIENTSECRET` / `TENANTID`
   - `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` / `SCOPES` (already in template)
   - `OBSERVABILITY_SERVICE_NAME` / `OBSERVABILITY_SERVICE_NAMESPACE`
   - Optional: `BEARER_TOKEN` if you want agentic auth via bearer
2) Run host: `python start_with_generic_host.py`
3) Health: `http://localhost:3978/api/health` (auto-fallback to next port if busy)
4) Playground/Bot Framework endpoint: `http://localhost:3978/api/messages`
   - Message text is forwarded into your CrewAI flow as the `location` input.
   - MCP servers from the Agent 365 platform are discovered and passed to CrewAI agents (SSE transport with bearer headers).

Agent 365 observability:
- Configured via `microsoft_agents_a365.observability.core.configure` in `agent.py`
- Agentic token is cached/resolved for the exporter (see `token_cache.py`)
- Startup logs show a masked env snapshot

## Understanding Your Crew
1) **Weather Checker**: Uses web search (Tavily) to find current weather conditions  
2) **Driving Safety Advisor**: Assesses whether it's safe to drive an MX-5 with summer tires based on weather data

## Project Structure
```
crew_agent/
├─ src/
│  └─ crew_agent/          # Main CrewAI application
│     ├─ config/           # Agent and task configs
│     ├─ tools/            # Custom tools (weather search)
│     ├─ crew.py           # Crew definition (now accepts MCPs)
│     ├─ main.py           # CLI entry points
│     └─ agent_runner.py   # External trigger interface
├─ agent.py                # Host wrapper (Agent 365 + MCP)
├─ host_agent_server.py    # Generic host (Microsoft Agents SDK)
├─ ToolingManifest.json    # MCP server sample config
├─ .env.template           # Env defaults
├─ pyproject.toml          # Dependencies
└─ README.md               # This file
```

## Support
- Docs: https://docs.crewai.com
- GitHub: https://github.com/joaomdmoura/crewai
- Discord: https://discord.com/invite/X4JWnZnxPb
