# CrewAgent Crew

Welcome to the CrewAgent Crew project, powered by [crewAI](https://crewai.com). This template is designed to help you set up a multi-agent AI system with ease, leveraging the powerful and flexible framework provided by crewAI. Our goal is to enable your agents to collaborate effectively on complex tasks, maximizing their collective intelligence and capabilities.

## Installation

Ensure you have Python >=3.10 <3.14 installed on your system. This project uses [UV](https://docs.astral.sh/uv/) for dependency management and package handling, offering a seamless setup and execution experience.

First, if you haven't already, install uv:

```bash
pip install uv
```

Next, navigate to your project directory and install the dependencies:

(Optional) Lock the dependencies and install them by using the CLI command:
```bash
crewai install
```
### Customizing

**Add your `OPENAI_API_KEY` into the `.env` file**

- Modify `src/crew_agent/config/agents.yaml` to define your agents
- Modify `src/crew_agent/config/tasks.yaml` to define your tasks
- Modify `src/crew_agent/crew.py` to add your own logic, tools and specific args
- Modify `src/crew_agent/main.py` to add custom inputs for your agents and tasks

## Running the Project

### Option 1: Run CrewAI Directly

To kickstart your crew of AI agents and begin task execution, run this from the root folder of your project:

```bash
$ crewai run
```

This command initializes the crew-agent Crew, assembling the agents and assigning them tasks as defined in your configuration.

### Option 2: Run via Agent Runner

Use the agent runner for more control:

```bash
$ python -m crew_agent.agent_runner "London"
```

Or use the command-line tool:

```bash
$ agent_runner "San Francisco, CA"
```

### Option 3: Run via Microsoft 365 Agent

For interactive use via Microsoft Teams, Copilot, or Agents Playground:

```bash
$ python start_with_generic_host.py
```

Then test with the Agents Playground:
```bash
$ teamsapptester
```

See the [M365 Agent README](src/m365_agent/README.md) for detailed setup instructions.

### Option 4: Hosted via Generic Agent Host (Microsoft Agents SDK)

This repo now mirrors the AgentFramework/OpenAI samples with a generic host:

1) Copy `.env.template` to `.env` and fill AGENTIC/observability settings (see other samples for values).  
2) Install deps: `uv sync` or `pip install -e .`  
3) Run: `python start_with_generic_host.py`  
4) Check health: `http://localhost:3978/api/health` (or the fallback port if 3978 is busy).  
5) Send chat messages via Agents Playground/Bot Framework endpoint `http://localhost:3978/api/messages`. Messages are passed into the CrewAI flow as the `location` input (existing CrewAI logic remains untouched).

## Understanding Your Crew

The crew-agent Crew is composed of multiple AI agents, each with unique roles, goals, and tools. These agents collaborate on a series of tasks, defined in `config/tasks.yaml`, leveraging their collective skills to achieve complex objectives. The `config/agents.yaml` file outlines the capabilities and configurations of each agent in your crew.

### Current Agents

1. **Weather Checker**: Uses web search (Tavily) to find current weather conditions
2. **Driving Safety Advisor**: Assesses whether it's safe to drive an MX-5 with summer tires based on weather data

## Project Structure

```
crew_agent/
├── src/
│   ├── crew_agent/          # Main CrewAI application
│   │   ├── config/          # Agent and task configurations
│   │   ├── tools/           # Custom tools (weather search)
│   │   ├── crew.py          # Crew definition
│   │   ├── main.py          # CLI entry points
│   │   └── agent_runner.py  # External trigger interface
│   │
│   └── m365_agent/          # Microsoft 365 Agents SDK integration
│       ├── app.py           # M365 agent application
│       ├── start_server.py  # Server setup
│       └── README.md        # M365-specific documentation
│
├── knowledge/               # Knowledge sources for agents
├── pyproject.toml          # Project dependencies
└── README.md               # This file
```

## Support

For support, questions, or feedback regarding the CrewAgent Crew or crewAI.
- Visit our [documentation](https://docs.crewai.com)
- Reach out to us through our [GitHub repository](https://github.com/joaomdmoura/crewai)
- [Join our Discord](https://discord.com/invite/X4JWnZnxPb)
- [Chat with our docs](https://chatg.pt/DWjSBZn)

Let's create wonders together with the power and simplicity of crewAI.
