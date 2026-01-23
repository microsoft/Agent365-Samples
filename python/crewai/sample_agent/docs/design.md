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

# Authentication
BEARER_TOKEN=...
AUTH_HANDLER_NAME=AGENTIC
CLIENT_ID=...
TENANT_ID=...

# Observability
OBSERVABILITY_SERVICE_NAME=crewai-sample-agent
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
    "crewai>=0.30.0",
    "microsoft-agents-hosting-aiohttp>=0.0.1",
    "microsoft-agents-hosting-core>=0.0.1",
    "microsoft_agents_a365_observability_core>=0.0.1",
    "microsoft_agents_a365_tooling_core>=0.0.1",
    "python-dotenv>=1.0.0",
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
