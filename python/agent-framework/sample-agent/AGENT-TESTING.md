# Agent Testing Guide

This document provides comprehensive testing instructions for the AgentFramework Agent sample, including setup, testing scenarios, troubleshooting, and validation steps.

## Overview

The AgentFramework Agent sample supports multiple testing modes and scenarios:
- **Local Development Testing**: Using console output and direct interaction
- **Microsoft 365 Agents SDK Testing**: Through the generic host server
- **MCP Tool Testing**: Validating external tool integrations
- **Observability Testing**: Verifying tracing and monitoring capabilities
- **Authentication Testing**: Both anonymous and agentic authentication modes

## Prerequisites

### Required Software
- Python 3.11 or higher
- Azure OpenAI access
- Azure CLI (for authentication)
- Access to Microsoft Agent365 MCP servers (for tool testing)

### Environment Setup
1. Install uv (Python package manager):
   ```powershell
   # On Windows
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   
   # Or using pip if you prefer
   pip install uv
   ```

2. Create and activate a virtual environment:
   ```powershell
   uv venv venv
   .\venv\Scripts\Activate.ps1
   ```

3. Create your environment configuration file:
   ```powershell
   Copy-Item .env.example .env
   ```
   Or create a new `.env` file with the required variables.

4. Configure your environment variables in `.env`:
   - Copy the `.env.example` file as a starting point
   - At minimum, set your Azure OpenAI credentials
   - Review other variables in `.env.example` and configure as needed for your testing scenario
   - **Azure OpenAI Configuration**: You need to specify your Azure OpenAI endpoint:
     ```env
     AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
     AZURE_OPENAI_DEPLOYMENT=gpt-4o       # Your deployment name
     AZURE_OPENAI_API_VERSION=2024-02-01  # API version
     ```

5. Authenticate with Azure CLI:
   ```bash
   az login
   ```

6. Install all dependencies (ensure your virtual environment is activated):
   
   **Using pyproject.toml with uv**
   ```powershell
   # Install dependencies using pyproject.toml
   uv pip install -e . or uv pip install -e . --preview
   ```
   
   **Note**: The pyproject.toml includes all required packages and a local index configuration pointing to `../../dist` for package resolution.
   ```toml
   # Local packages from local index
   # - Update package versions to match your built wheels
   "microsoft_agents_a365_tooling >= 2025.10.20",
   "microsoft_agents_a365_tooling_extensions_agentframework >= 2025.10.20",
   "microsoft_agents_a365_observability_core >= 2025.10.20",
   "microsoft_agents_a365_notifications >= 2025.10.20",
   ```
   
   **Important**: Verify these package versions match your locally built wheels in the `../../dist` directory and ensure the directory path is correct before installation.

## Testing Scenarios

### 1. Basic Agent Functionality Testing

#### Basic Conversation Testing
- **Purpose**: Test AI model integration and response generation through proper endpoints
- **Setup**: Use the hosted server mode with `/api/messages` endpoint
- **Test Cases**:
  - Simple greeting: "Hello, how are you?"
  - Information request: "What can you help me with?"
  - Complex query: "Explain quantum computing in simple terms"

**Expected Results**:
- Coherent, helpful responses
- Response times under 10 seconds
- No authentication or API key errors

### 2. Server Hosting Testing

#### Start the Generic Host Server
```powershell
uv run python start_with_generic_host.py
```

**Expected Console Output for the Python server:**
```
================================================================================
Microsoft Agents SDK Integration - OFFICIAL IMPLEMENTATION  
================================================================================

🔒 Authentication: Anonymous (or Agentic if configured)
Using proper Microsoft Agents SDK patterns
🎯 Compatible with Agents Playground

🚀 Starting server on localhost:3978
📚 Microsoft 365 Agents SDK endpoint: http://localhost:3978/api/messages
❤️ Health: http://localhost:3978/api/health
🎯 Ready for testing!
```

#### Testing with Microsoft 365 Agents Playground
After starting the server, you can test it using the Microsoft 365 Agents Playground.
In a separate terminal, start the playground:
```powershell

agentsplayground

```

You should see the Microsoft 365 Agents Playground running locally

#### Health Check Testing
- **Test**: `Invoke-RestMethod -Uri http://localhost:3978/api/health` (PowerShell) or `curl http://localhost:3978/api/health`
- **Expected Response**:
  ```json
  {
    "status": "ok",
    "agentframework_agent_initialized": true,
    "auth_mode": "anonymous"
  }
  ```

#### Port Conflict Testing
- **Test**: Start multiple instances simultaneously
- **Expected Behavior**: Server automatically tries next available port (3979, 3980, etc.)
- **Validation**: Check console output for actual port used

### 3. Microsoft 365 Agents SDK Integration Testing

#### Message Endpoint Testing
- **Endpoint**: `POST http://localhost:3978/api/messages`
- **Test Payload**:
  ```json
  {
    "type": "message",
    "text": "Hello, can you help me?",
    "from": {
      "id": "test-user",
      "name": "Test User"
    },
    "conversation": {
      "id": "test-conversation"
    }
  }
  ```


#### Expected Response Flow
1. Server receives message
2. Agent processes request with observability tracing
3. Response returned with appropriate structure
4. Trace output visible in console (if observability enabled)

### 4. MCP Tool Integration Testing

#### Testing from Microsoft 365 Agents Playground
Once you have the agent running and the playground started with `teamsapptester`, you can test MCP tool functionality directly through the playground interface:

- **Interactive Testing**: Use the playground's chat interface to request tool actions
- **Real-time Feedback**: See tool execution results immediately in the conversation
- **Visual Validation**: Confirm tools are working through the user-friendly interface

#### Tool Discovery Testing
- **Validation Points**:
  - Tools loaded from MCP servers during agent initialization
  - Console output shows tool count: "✅ Loaded X tools from MCP servers"
  - No connection errors to MCP servers

#### Tool Functionality Testing
- **Email Tools** (if available):
  - "Send an email to test@example.com with subject 'Test' and body 'Hello'"
  - "Check my recent emails"
  - "Help me organize my inbox"

- **Calendar Tools** (if available):
  - "Create a meeting for tomorrow at 2 PM"
  - "Check my availability this week"
  - "Show my upcoming appointments"

#### Tool Error Handling Testing
- **Scenarios**:
  - Request tools when MCP servers are unavailable
  - Invalid tool parameters
  - Authentication failures for tool access

- **Expected Behavior**:
  - Graceful error messages to users
  - Agent continues functioning without tools
  - Clear error logging for debugging

### 5. Authentication Testing

#### Anonymous Authentication Testing
- **Configuration**: Default setup without agentic auth
- **Expected Behavior**:
  - Agent starts successfully
  - Basic functionality works
  - Console shows "🔒 Authentication: Anonymous"

#### Agentic Authentication Testing
- **Configuration**: Set `USE_AGENTIC_AUTH=true` in `.env`
- **Required Environment Variables**:
  ```env
  USE_AGENTIC_AUTH=true
  AGENT_ID=your_agent_id
  CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID=client_id
  CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET=client_secret
  CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID=tenant_id
  ```

- **Testing through Agents Playground**:
  1. Ensure that Agentic Auth is set up as in the previous step
  2. Start the AgentsPlayground with `teamsapptester`
  3. Click on **'Mock An Activity'** → **'Trigger Custom Activity'** → **'Custom activity'**
  4. Add the following JSON payload:
     ```json
     {
       "type": "message",
       "id": "c4970243-ca33-46eb-9818-74d69f553f63",
       "timestamp": "2025-09-24T17:40:19+00:00",
       "serviceUrl": "http://localhost:56150/_connector",
       "channelId": "agents",
       "from": {
         "id": "manager@contoso.com",
         "name": "Agent Manager",
         "role": "user"
       },
       "recipient": {
         "id": "a365testingagent@testcsaaa.onmicrosoft.com",
         "name": "A365 Testing Agent",
         "agenticUserId": "ea1a172b-f443-4ee0-b8a1-27c7ab7ea9e5",
         "agenticAppId": "933f6053-d249-4479-8c0b-78ab25424002",
         "tenantId": "5369a35c-46a5-4677-8ff9-2e65587654e7",
         "role": "agenticUser"
       },
       "conversation": {
         "conversationType": "personal",
         "tenantId": "00000000-0000-0000-0000-0000000000001",
         "id": "personal-chat-id"
       },
       "membersAdded": [],
       "membersRemoved": [],
       "reactionsAdded": [],
       "reactionsRemoved": [],
       "locale": "en-US",
       "attachments": [],
       "entities": [
         {
           "id": "email",
           "type": "productInfo"
         },
         {
           "type": "clientInfo",
           "locale": "en-US",
           "timezone": null
         },
         {
           "type": "emailNotification",
           "id": "c4970243-ca33-46eb-9818-74d69f553f63",
           "conversationId": "personal-chat-id",
           "htmlBody": "<body dir=\"ltr\">\n<div class=\"elementToProof\" style=\"font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);\">\n Send Email to <your email> with subject 'Hello World' and message 'This is a test'. </div>\n\n\n</body>"
         }
       ],
       "channelData": {
         "tenant": {
           "id": "00000000-0000-0000-0000-0000000000001"
         }
       },
       "listenFor": [],
       "textHighlights": []
     }
     ```

- **Expected Behavior**:
  - Agent starts with Azure AD authentication
  - Console shows "🔒 Authentication: Agentic"
  - Tool access uses authenticated context
  - Custom activity is processed successfully through the playground

### 6. Observability Testing

**Prerequisites**: Ensure your `.env` file includes the observability configuration:
```env
# Observability Configuration
OBSERVABILITY_SERVICE_NAME=agentframework-agent-sample
OBSERVABILITY_SERVICE_NAMESPACE=agents.samples
ENABLE_A365_OBSERVABILITY_EXPORTER=false  # For console output during development
```

#### Trace Output Validation
- **Expected Console Output**:
  ```
  ✅ Observability configured successfully
  ```

#### Span Creation Testing
- **Test**: Send a message to the agent
- **Expected Trace Elements**:
  - Custom span: "process_user_message"
  - Span attributes: message length, content preview
  - Azure OpenAI API call spans (automatic instrumentation when available)
  - Tool execution spans (if tools are used)

**Sample Console Output**:
```json
{
    "name": "process_user_message",
    "context": {
        "trace_id": "0x46eaa206d93e21d1c49395848172f60b",
        "span_id": "0x6cd9b00954a506aa"
    },
    "kind": "SpanKind.INTERNAL",
    "start_time": "2025-10-16T00:01:54.794475Z",
    "end_time": "2025-10-16T00:02:00.824454Z",
    "status": {
        "status_code": "UNSET"
    },
    "attributes": {
        "user.message.length": 59,
        "user.message.preview": "Send Email to YourEmail@microsoft.com saying Hel...",
        "response.length": 133,
        "response.preview": "The email saying \"Hello World!\" has been successfu..."
    },
    "resource": {
        "attributes": {
            "service.namespace": "agent365-samples",
            "service.name": "agentframework-agent-sample"
        }
    }
}
```

#### Error Tracing Testing
- **Test**: Force an error (invalid API credentials, network issues)
- **Expected Behavior**:
  - Exceptions recorded in spans
  - Error status set on spans
  - Detailed error information in traces

## Troubleshooting Common Issues

### Agent Startup Issues

#### Azure OpenAI Configuration Problems
- **Error**: "AZURE_OPENAI_ENDPOINT environment variable is required"
- **Solution**: Verify Azure OpenAI configuration in `.env` file
- **Validation**: Check Azure CLI authentication with `az login`

#### Import Errors
- **Error**: "Required packages not installed"
- **Solution**: Run `uv pip install -e .`
- **Note**: Ensure using Python 3.11+ and correct virtual environment

#### Port Binding Errors
- **Error**: "error while attempting to bind on address"
- **Solution**: Server automatically tries next port, or set custom `PORT` in `.env`

### Runtime Issues

#### MCP Server Connection Failures
- **Symptoms**: "Error setting up MCP servers" in logs
- **Causes**: Network issues, authentication problems, server unavailability
- **Solutions**:
  - Check network connectivity
  - Verify bearer token or agentic auth configuration
  - Confirm MCP server URLs are correct

#### Observability Configuration Failures
- **Symptoms**: "WARNING: Failed to configure observability"
- **Impact**: Agent continues working, but without tracing
- **Solutions**:
  - Check Microsoft Agent 365 observability packages installation
  - Verify environment variables are set correctly
  - Review console output for specific error details

#### Model API Errors
- **Symptoms**: API call failures, authentication errors
- **Solutions**:
  - Check Azure CLI authentication status
  - Verify Azure OpenAI endpoint and deployment name
  - Ensure proper Azure RBAC permissions

### Testing Environment Issues

#### Authentication Context Problems
- **Symptoms**: Tools fail to execute, authorization errors
- **Solutions**:
  - Verify agentic authentication setup
  - Check bearer token validity
  - Ensure proper Azure AD configuration

#### Network Connectivity Issues
- **Symptoms**: Timeouts, connection refused errors
- **Solutions**:
  - Check internet connectivity
  - Verify firewall settings
  - Test MCP server URLs directly

## Validation Checklist

### ✅ Basic Functionality
- [ ] Agent initializes without errors
- [ ] Observability configuration succeeds
- [ ] Health endpoint returns 200 OK
- [ ] Basic conversation works
- [ ] Graceful error handling

### ✅ Server Integration
- [ ] Microsoft 365 Agents SDK endpoint responds
- [ ] Message processing works end-to-end
- [ ] Concurrent requests handled properly
- [ ] Server shutdown is clean

### ✅ MCP Tool Integration
- [ ] Tools discovered and loaded
- [ ] Tool execution works correctly
- [ ] Tool errors handled gracefully
- [ ] Authentication context passed properly

### ✅ Observability
- [ ] Traces appear in console output
- [ ] Custom spans created correctly
- [ ] Exception tracking works
- [ ] Performance metrics captured

### ✅ Authentication
- [ ] Anonymous mode works for development
- [ ] Agentic authentication works for enterprise
- [ ] Proper authentication context propagation
- [ ] Secure credential handling

### ✅ Configuration
- [ ] Environment variables loaded correctly
- [ ] Default values work appropriately
- [ ] Error messages are clear and actionable
- [ ] Different model configurations work

This comprehensive testing guide ensures the AgentFramework Agent sample is thoroughly validated across all its capabilities and integration points.

