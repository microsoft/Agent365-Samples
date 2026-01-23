# Google ADK Sample Agent Design (Python)

## Overview

This sample demonstrates an agent built using Google's Agent Development Kit (ADK). It showcases integration with Google's AI models and tools within the Microsoft Agent 365 ecosystem.

## What This Sample Demonstrates

- Google ADK integration with Agent 365
- Google AI model configuration
- MCP tool integration with Google ADK
- Microsoft Agent 365 observability
- Async message processing

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
│                    GoogleADKAgent                                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Google AI Client                          ││
│  │  Google ADK → Gemini Model → Response                        ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    MCP Tools                                 ││
│  │  Tool Registration → Function Calling → Tool Execution       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### agent.py
Main agent implementation:
- Google ADK client configuration
- Gemini model setup
- MCP tool integration
- Message processing

## Google ADK-Specific Patterns

### Agent Setup
```python
import google.generativeai as genai

class GoogleADKAgent(AgentInterface):
    def __init__(self):
        # Configure Google AI
        genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))

        # Create model with tools
        self.model = genai.GenerativeModel(
            model_name="gemini-1.5-pro",
            system_instruction=self.system_prompt,
        )

    async def process_user_message(self, message, auth, auth_handler_name, context):
        # Setup MCP tools for Google ADK
        tools = await self.setup_mcp_tools(auth, auth_handler_name, context)

        # Generate response with function calling
        response = await self.model.generate_content_async(
            message,
            tools=tools,
        )

        # Handle function calls if present
        while response.candidates[0].content.parts[-1].function_call:
            function_response = await self.execute_function(
                response.candidates[0].content.parts[-1].function_call
            )
            response = await self.model.generate_content_async(
                [message, response.candidates[0].content, function_response],
                tools=tools,
            )

        return response.text
```

## Configuration

### .env file
```bash
# Google AI Configuration
GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-1.5-pro

# Authentication
BEARER_TOKEN=...
AUTH_HANDLER_NAME=AGENTIC
CLIENT_ID=...
TENANT_ID=...

# Observability
OBSERVABILITY_SERVICE_NAME=google-adk-sample-agent
```

## Message Flow

```
1. HTTP POST /api/messages
2. GenericAgentHost routes to Google ADK agent
3. Gemini model processes message
4. Function calling loop if tools requested
5. Final response returned
```

## Dependencies

```toml
[project]
dependencies = [
    "google-generativeai>=0.5.0",
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

1. **Model Selection**: Choose different Gemini models
2. **MCP Tools**: Configure in tool manifest
3. **System Instructions**: Customize agent behavior
4. **Safety Settings**: Configure content filters
