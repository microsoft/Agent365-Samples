# Sample Agent - Python Claude Agent SDK

This directory contains a sample agent implementation using Python and Anthropic's Claude Agent SDK with extended thinking capabilities.

## Demonstrates

This sample demonstrates how to build an agent using the Agent365 framework with Python and Claude Agent SDK, including:
- Claude Agent SDK integration with extended thinking
- Built-in Claude tools (Read, Write, WebSearch, Bash, Grep)
- Microsoft 365 notifications (@mentions from Outlook, Word, Teams)
- Microsoft Agent 365 observability and tracing
- Multiple authentication modes (anonymous and agentic)
- Microsoft 365 Agents SDK hosting patterns

## Prerequisites

- Python 3.11+
- Anthropic Claude API access (API key)
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)

## Documentation

For detailed information about this sample, please refer to:

- **[AGENT-CODE-WALKTHROUGH.md](AGENT-CODE-WALKTHROUGH.md)** - Detailed code explanation and architecture walkthrough
- **[PARITY_ANALYSIS.md](PARITY_ANALYSIS.md)** - Feature comparison with agent-framework and OpenAI samples
- **[NOTIFICATION_IMPLEMENTATION.md](NOTIFICATION_IMPLEMENTATION.md)** - Notification support implementation details

## Quick Start

### 1. Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

### 2. Set Up Environment

```bash
# Copy the template
cp .env.template .env

# Edit .env and set your API key
# ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Install Dependencies

```bash
# Create virtual environment and install
uv venv
uv pip install -e .
```

### 4. Run the Agent

```bash
uv run python start_with_generic_host.py
```

The agent will start on `http://localhost:3978` and can be tested with the Agents Playground:

```bash
# In a new terminal
agentsplayground
```

## Key Features

### Claude Agent SDK Integration
- Uses `claude-sonnet-4-20250514` model with extended thinking
- Built-in tools: Read, Write, WebSearch, Bash, Grep
- Streaming responses with thinking process visibility

### Notification Support
- Handles @mentions from Outlook emails
- Processes Word document comments
- Responds to Teams messages
- Dual channel support (agents + msteams for testing)

### Observability
- Microsoft Agent 365 observability integration
- Console trace output for development
- Agent 365 Observability exporter support for production

### Authentication Modes
- **Anonymous**: Simple testing without authentication
- **Agentic**: Full Microsoft 365 authentication with token exchange

## Environment Variables

### Required
```env
ANTHROPIC_API_KEY=sk-ant-...     # Your Claude API key
```

### Optional
```env
# Authentication
USE_AGENTIC_AUTH=false           # true for production auth
AGENT_ID=user123                 # Agent identifier

# Observability
ENABLE_OBSERVABILITY=true        # Enable telemetry
OBSERVABILITY_SERVICE_NAME=claude-agent
OBSERVABILITY_SERVICE_NAMESPACE=agents.samples

# Server
PORT=3978                        # HTTP server port
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Microsoft 365 Agents Playground / Client       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  host_agent_server.py                           │
│  - HTTP endpoint (/api/messages)                │
│  - Authentication middleware                    │
│  - Notification routing                         │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  agent.py (ClaudeAgent)                         │
│  - Message processing                           │
│  - Notification handling                        │
│  - Claude SDK integration                       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Claude Agent SDK                               │
│  - Extended thinking                            │
│  - Built-in tools                               │
│  - Streaming responses                          │
└─────────────────────────────────────────────────┘
```

## Built-in Claude Tools

The Claude Agent SDK provides these tools out of the box:

- **Read**: Read files from the workspace
- **Write**: Create/modify files
- **WebSearch**: Search the web for information
- **Bash**: Execute shell commands
- **Grep**: Search file contents

No additional MCP server configuration needed!

## Known Issues & Limitations

1. **Package Patches Required**: The notification package has bugs requiring 3 patches:
   - `__init__.py` - Fixed broken imports
   - `agent_notification.py` - Fixed NoneType handling and channel routing
   - `agent_notification_activity.py` - Fixed None activity.name crash

2. **MCP Support**: Currently not implemented (P0 gap from parity analysis)
   - No Mail, Calendar, SharePoint tools
   - Planned for future implementation

3. **Auto-instrumentation**: Not yet available for Claude Agent SDK
   - Manual telemetry implementation in place
   - Automatic instrumentation pending SDK support

## Troubleshooting

### "Not authenticated with Claude"
```bash
claude login
```

### Port 3978 already in use
```bash
# Find and kill the process
netstat -ano | findstr :3978
taskkill /PID <PID> /F
```

### Notifications not routing
- Check that both 'agents' and 'msteams' handlers are registered
- Verify package patches are applied
- Enable debug logging to see channel matching

## 📚 Related Documentation

- [Claude Agent SDK](https://anthropic.mintlify.app/en/api/agent-sdk/overview)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/)
- [Microsoft Agents A365 Python](https://github.com/microsoft/Agent365-python)

## 🤝 Contributing

1. Follow the existing code patterns and structure
2. Add comprehensive logging and error handling
3. Update documentation for new features
4. Test thoroughly with different authentication methods
5. Apply package patches when needed

## 📄 License

TBD