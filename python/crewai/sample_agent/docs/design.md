# CrewAI Sample Agent Design (Python)

## Overview

This sample demonstrates an agent built using CrewAI, a multi-agent orchestration framework. It showcases how to integrate CrewAI's crew and agent patterns with Microsoft Agent 365.

## What This Sample Demonstrates

- CrewAI integration with Agent 365
- Multi-agent orchestration patterns
- Task-based agent workflows
- MCP tool integration with CrewAI
- Microsoft Agent 365 observability

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  start_with_generic_host.py                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GenericAgentHost                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CrewAIAgent                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Crew                                    ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         ││
│  │  │ Agent 1     │  │ Agent 2     │  │ Agent N     │         ││
│  │  │ (Role)      │  │ (Role)      │  │ (Role)      │         ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘         ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Tasks                                   ││
│  │  Task 1 → Task 2 → ... → Final Output                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### agent.py
Main agent implementation:
- Crew and agent configuration
- Task definition and sequencing
- MCP tool integration

## CrewAI-Specific Patterns

### Crew Setup
```python
from crewai import Agent, Crew, Task

class CrewAIAgent(AgentInterface):
    def __init__(self):
        # Define agents with roles
        self.researcher = Agent(
            role="Researcher",
            goal="Research and gather information",
            backstory="Expert researcher...",
            tools=self.mcp_tools,
        )

        self.writer = Agent(
            role="Writer",
            goal="Create clear responses",
            backstory="Expert communicator...",
        )

        # Create crew
        self.crew = Crew(
            agents=[self.researcher, self.writer],
            tasks=[],  # Tasks added per request
            verbose=True,
        )

    async def process_user_message(self, message, auth, auth_handler_name, context):
        # Create task for this message
        research_task = Task(
            description=f"Research: {message}",
            agent=self.researcher,
        )

        response_task = Task(
            description="Create response from research",
            agent=self.writer,
        )

        self.crew.tasks = [research_task, response_task]
        result = await self.crew.kickoff_async()
        return str(result)
```

## Configuration

### .env file
```bash
# LLM Configuration (used by CrewAI)
OPENAI_API_KEY=sk-...
AZURE_API_KEY=...
AZURE_API_BASE=https://your-resource.openai.azure.com/
AZURE_API_VERSION=2025-01-01-preview
AZURE_OPENAI_DEPLOYMENT=azure/gpt-4.1
OPENAI_MODEL_NAME=azure/gpt-4.1

# Authentication
BEARER_TOKEN=...
USE_AGENTIC_AUTH=false
AUTH_HANDLER_NAME=AGENTIC
AGENTIC_AUTH_SCOPE=https://api.powerplatform.com/.default
AGENT_ID=...
AGENTIC_APP_ID=crewai-agent

# Weather Search
TAVILY_API_KEY=tvly-...

# Observability
OBSERVABILITY_SERVICE_NAME=crewai-agent-sample
OBSERVABILITY_SERVICE_NAMESPACE=agent365-samples
ENABLE_OBSERVABILITY=true
ENABLE_A365_OBSERVABILITY_EXPORTER=false
PYTHON_ENVIRONMENT=development

# Server
PORT=3978
LOG_LEVEL=INFO
```

## Message Flow

```
1. HTTP POST /api/messages
2. GenericAgentHost routes to CrewAI agent
3. Tasks created for user message
4. Crew executes tasks across agents
5. Final output returned
```

## Dependencies

```toml
[project]
dependencies = [
    "crewai[azure-ai-inference,tools]==1.4.1",
    "tavily-python>=0.3.0",
    "python-dotenv>=1.0.0",
    "microsoft-agents-hosting-aiohttp>=0.9.0",
    "microsoft-agents-hosting-core>=0.9.0",
    "microsoft-agents-authentication-msal>=0.9.0",
    "microsoft-agents-activity>=0.9.0",
    "aiohttp",
    "microsoft_agents_a365_tooling>=0.1.0",
    "microsoft_agents_a365_observability_core>=0.1.0",
    "microsoft_agents_a365_observability_hosting>=0.1.0",
    "microsoft_agents_a365_notifications>=0.1.0",
    "microsoft_agents_a365_runtime>=0.1.0",
]
```

## Running the Agent

```bash
uv run python start_with_generic_host.py
```

## Extension Points

1. **Additional Agents**: Add specialized agents to crew
2. **Custom Tasks**: Define task workflows
3. **MCP Tools**: Assign tools to specific agents
4. **Process Types**: Sequential, hierarchical, or custom
