# Procurement Agent

This is an implementation of a Procurement Agent that utilizes Agent 365 capabilities. The agent is designed for a demo scenario and includes mock integrations with SAP and Genspark.

This is based off the Hello World A365 Agent.

# Running Agent Locally

Existing resources are set up to work OOB during local dev for resources in ZTAI tenant.

For running this app with any other tenant, please update the below values in appsettings.json to point to resources deployed in the specific tenant:
- KeyVaultName
- AzureOpenAIEndpoint
- AzureStorageEndpoint
- GraphReadApplicationId
- LookbackPeriod (Increase this setting if you want to process agent users which were created more than 3 hours ago)

These additional values should be updated for Messaging notifications to work properly:
- Connections:ServiceConnection:AuthorityEndpoint (should be https://login.microsoftonline.com/{tenant_id} for the tenant where agent blueprint is created)
- Connections:ServiceConnection:ClientId (should be the agent_blueprint_id)
- Connections:ServiceConnection:ClientSecret (should be the secret for the agent blueprint)

For SAP integration using OData, update the SAP username and password values in appsettings.json to your SAP system credentials.

To run locally, first run this to ensure your access token is generated:

`az login`

To build:

`dotnet build`

To run locally for localhost:

`dotnet run`

You should start to see logs for the Agent Background Service running.

To start processing new agent users created for an agent blueprint in local dev automatically, run [provision-agent-blueprint.ps1 ](provision-agent-blueprint.ps1) script. This will prompt for tenant_id and agent_blueprint_id (that you want to use for dev testing).

# Deploy AppService to Azure

To deploy to AppService, do:

**azd auth login**
**azd up**

To avoid conflict with other devs, please deploy to your own app service for now. There is one additional step needed to grant your appservice Managed Identity access to the AI resources. The tutorial link at the top has details on how to do that.

# Testing ABS/AgentSdk Locally

Install playground tools:

**winget install agentsplayground**

Make sure your local app is running, then do. You may need to use a clean powershell window:

**agentsplayground -e "http://localhost:7258/api/messages" -c "emulator"**

This will load a browser that you can then directly use to send messages.

# Agent SDK Integrations

This application integrates with the Microsoft 365 Agent SDK. The integration consists of several key components:

## Controller Configuration

The Agent SDK endpoint is configured in `Program.cs` through the `AgentController`, which exposes the `/api/messages` endpoint for receiving agent messages. This controller handles incoming activity messages from the Agent SDK and routes them to the appropriate agent logic.

## Agent Application

The core agent logic is implemented in the `AgentLogic/A365AgentApplication.cs` class, which:
- Processes incoming activity messages
- Determines the appropriate actions based on message content
- Routes to the correct Agentic Identity
- Processes the request using semantic kernal orchestration within agentic identity context


# Notification Background Service (Mock Messaging service)

The application includes a robust notification system implemented through the `BackgroundNotificationService` that provides continuous monitoring of stored agent entities.

## Service Architecture

The notification service runs as a background service and performs the following functions:

1. **Agent Entity Monitoring**: Continuously polls stored agent configurations from the database
2. **Message Collection**: For each active agent, collects new emails and Teams messages since the last check
3. **Message Forwarding**: Forwards notifications to configured messaging endpoints using the activity protocol

## Processing Flow

The service operates on a configurable interval (default 30 seconds) and:
- Retrieves all active agents from storage
- For each agent, calls Graph API to get new emails and Teams messages
- Forwards notifications to the Agent SDK messaging endpoints
- Updates the last check timestamp for each agent

## Integration Points

The notification service integrates with:
- **StorageTableService**: For persisting agent configurations and state
- **GraphService**: For retrieving emails and Teams messages via Microsoft Graph API
- **AgentMessagingService**: For forwarding notifications to agent endpoints
- **A365AgentApplication**: For agent logic and generating responses

This background processing ensures that monitoring continues even when users aren't actively interacting with the agent, providing comprehensive coverage of communication activities.

# Agent Token Helper & Agentic User Identity

The `AgentTokenHelper` service implements the Entra Agent ID authentication flow to obtain user tokens on behalf of agents. This enables agents to access Microsoft Graph APIs with delegated user permissions, allowing them to read emails, Teams messages, and perform actions as the monitored user.

## Three-Step Authentication Process

The `GetAgenticUserTokenAsync` method implements a three-step token acquisition process:

### Step 1: Agent Application Token
- **Purpose**: Authenticate the central agent application
- **Credentials**: Uses certificate-based authentication with the Agent Application ID
- **Scope**: `api://AzureAdTokenExchange/.default`
- **Additional Parameters**: Includes `fmi_path` parameter with the Agent Instance ID
- **Result**: Agent application access token for the token exchange service

### Step 2: Agent Instance Token  
- **Purpose**: Authenticate the specific agent instance
- **Credentials**: Uses the token from Step 1 as a client assertion
- **Client ID**: Agent Instance ID 
- **Scope**: `api://AzureAdTokenExchange/.default`
- **Grant Type**: `client_credentials` with JWT bearer assertion
- **Result**: Agent instance access token for user identity federation

### Step 3: User Federated Identity Token
- **Purpose**: Obtain delegated user access token
- **Credentials**: Uses tokens from both Step 1 and Step 2
- **Grant Type**: `user_fic` (User Federated Identity Credential)
- **Parameters**:
  - `client_assertion`: JWT token from Step 1 (agent app token)
  - `user_federated_identity_credential`: JWT token from Step 2 (instance token) 
  - `username`: Agent User's UPN 
  - `scope`: Target Microsoft Graph scopes (e.g., `https://graph.microsoft.com/Mail.Read` or `https://canary.graph.microsoft.com/.default`)

## Token Management

The system includes sophisticated token management through:

- **AgentTokenCredential**: Implements `Azure.Core.TokenCredential` for seamless integration with Azure SDK
- **Token Caching**: Automatic caching with JWT expiry parsing to minimize token requests
- **Thread Safety**: Uses semaphore-based locking to prevent concurrent token acquisition
- **Automatic Refresh**: Tokens are refreshed automatically with a 5-minute buffer before expiry
- **Error Handling**: Graceful fallback to certificate-based application authentication if agentic flow fails

## Integration with Microsoft Graph

The agentic user tokens require that the permissions be consented in graph like https://login.microsoftonline.com/0618cee6-6dee-4393-9dea-efaf68e088a4/v2.0/adminconsent?client_id=9a30198f-8b51-4538-93fc-b2ffb672a839&scope=User.Read&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123

This authentication model ensures that all Graph API calls are performed in the context of the agentic user.

## Hiring Notifications

The system includes functionality to track agent applications and notify when new agentic identities are created.

### REST API Endpoints

- `GET /api/AgentApplicationEntity` - Get all entities for current service
- `POST /api/AgentApplicationEntity` - Create new entity
- `PUT /api/AgentApplicationEntity/{id}` - Update existing entity
- `DELETE /api/AgentApplicationEntity/{id}` - Delete entity

### Usage

1. Create an entity using the POST endpoint specifying the tenant and entity ID (which serves as the application ID to track)
2. Optionally configure a `WebhookUrl` to receive installation notifications
3. The background service will automatically start discovering new agent instances
4. When new instances are found, the system will:
   - Create a `AgentMetadata` record for the new instance
   - Query Microsoft Graph to get the agent user details
   - Send an installation activity event to the configured webhook URL (if provided)

### Conditions
The on hire notification will not be sent until the following conditions are met.

1. Agentic Identity has required consents - ["Mail.ReadWrite", "Mail.Send", "Chat.ReadWrite"]
2. Agent User has a manager
3. Agant User has required licenses (Teams Enterprise and E5)

The code will also create a chat between the agent and the manager.

### Installation Event Format

When a new agent instance is discovered, an installation event is sent to the webhook URL in this format:

```json
{
    "type": "installationUpdate",
    "channelId": "msteams",
    "from": {
        "id": "manager-email-id",
        "name": "Manager Display Name",
        "aadObjectId": "manager-aad-object-id"
    },
    "recipient": {
        "id": "AA",
        "name": "AU UPN",
        "role": "agentuser",
        "aadObjectId": "AU OID",
        "aadClientId": "AAI"
    },
    "conversation": {
        "isGroup": false,
        "id": "agent-conversation-id",
        "tenantId": "tenant-id"
    },
    "text": "Agent [Name] has been installed",
    "channelData": {
        "action": "add"
    }
}
```



# Troubleshooting

If you hit

> Error NU1105 : Unable to find project information for '...\Agent365\dotnet\sdk\Agent365Sdk\Agent365Sdk.csproj'. If you are using Visual Studio, this may be because the project is unloaded or not part of the current solution so run a restore from the command-line. Otherwise, the project file may be invalid or missing targets required for restore.

Run restore first

If you get errors with MCP servers using teams tools, try changing the Teams server in [ToolingManifest.json](ToolingManifest.json) to use canary.

```json
{
    "mcpServerName": "mcp_TeamsCanaryServer",
    "mcpServerUniqueName": "mcp_TeamsCanaryServer"
}
```
