
# n8n Agent Code Walkthrough

This document provides a detailed technical walkthrough of the n8n Sample Agent implementation, covering architecture, key components, activity handling, and integration patterns with n8n workflows.

## 📁 File Structure Overview

```
sample-agent/
├── src/
│   ├── index.ts                      # 🔵 Express server entry point
│   ├── agent.ts                      # 🔵 Agent application and activity routing
│   ├── n8nAgent.ts                   # 🔵 Core business logic and lifecycle management
│   ├── n8nClient.ts                  # 🔵 n8n webhook client with observability
│   ├── mcpToolRegistrationService.ts # 🔵 MCP tool discovery and registration
│   └── telemetry.ts                  # 🔵 Observability configuration
├── ToolingManifest.json              # 🔧 MCP tool server definitions
├── package.json                      # 📦 Dependencies and scripts
├── tsconfig.json                     # 🔧 TypeScript configuration
├── .env.example                      # ⚙️ Environment template
└── Documentation files...
```

## 🏗️ Architecture Overview

### Design Principles
1. **n8n Integration**: Forwards all processing to n8n workflows via webhooks
1. **Event-Driven**: Bot Framework activity handlers for messages, notifications, and lifecycle events
1. **Stateful**: Tracks installation and terms acceptance status
1. **Observable**: Comprehensive telemetry with InvokeAgentScope and InferenceScope
1. **Tool-Enabled**: MCP tool integration for Microsoft 365 services

### High-Level Flow
```
┌─────────────────────────────────────────────────────────────────┐
│                    n8n Agent Architecture                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Teams/M365 → CloudAdapter → AgentApplication → N8nAgent        │
│                                   ↓                              │
│                            Activity Router                       │
│                      ┌──────────┼──────────┐                   │
│                      ↓          ↓          ↓                    │
│                 Message    Installation  (Future:               │
│                 Activity     Activity    Notifications)         │
│                      ↓          ↓                               │
│                 N8nClient  State Updates                        │
│                      ↓                                          │
│                 MCP Tools                                       │
│                 Discovery                                       │
│                      ↓                                          │
│               n8n Webhook (POST)                                │
│                      ↓                                          │
│            { text, from, mcpServers }                           │
│                      ↓                                          │
│              n8n Workflow Processing                            │
│                      ↓                                          │
│              { output: "response" }                             │
│                      ↓                                          │
│           Response to Teams/M365                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 🔍 Core Components Deep Dive

### Code Overview

#### index.ts - Express Server Entry Point
- Loads authentication configuration from environment variables
- Sets up Express server with JSON parsing and JWT authorization middleware
- Configures `/api/messages` endpoint for Bot Framework message processing
- Manages observability lifecycle (start on launch, shutdown on error/close)
- Handles graceful shutdown on SIGINT/SIGTERM signals

#### agent.ts - Agent Application Setup
- Defines conversation state interface (`ConversationState` with message count)
- Creates `AgentApplication` with memory storage and file download support
- Registers activity handlers:
  - **Message Activity**: Increments counter, delegates to `N8nAgent.handleAgentMessageActivity`
  - **InstallationUpdate Activity**: Delegates to `N8nAgent.handleInstallationUpdateActivity`

#### n8nAgent.ts - Core Business Logic
- Manages agent state: `isApplicationInstalled` and `termsAndConditionsAccepted`
- **Message Handler**: Enforces installation → terms acceptance → processing flow
- **Installation Handler**: Sets state flags and sends welcome/goodbye messages
- **Notification Handlers**: Processes email and Word @-mention notifications with two-stage flow (metadata extraction → content retrieval via n8n)
- **getN8nClient**: Discovers MCP tool servers and creates configured N8nClient

#### n8nClient.ts - Webhook Client with Observability
- Constructs JSON payload with user message, sender name, and MCP tool metadata
- POSTs to `N8N_WEBHOOK_URL` with optional authentication header
- Parses response expecting `{ output: "text" }` format
- Wraps invocations with nested observability spans:
  - **InvokeAgentScope**: Tracks entire agent invocation
  - **InferenceScope**: Tracks n8n workflow execution with input/output recording

#### mcpToolRegistrationService.ts - MCP Tool Discovery
- `getMcpServers`: Lists tool servers from configuration service, retrieves agentic token if needed
- `getTools`: Connects to each MCP server via HTTP transport, lists available tools with schemas
- Returns array of `McpServer` objects with tool metadata for n8n workflows

#### telemetry.ts - Observability Configuration
- Configures `ObservabilityManager` with service name and version
- Can be extended with exporters (Console, OTLP, etc.)
- Lifecycle managed in `index.ts`

---

## 🎯 Design Patterns and Best Practices

### Separation of Concerns
- **index.ts**: Server infrastructure
- **agent.ts**: Activity routing
- **n8nAgent.ts**: Business logic
- **n8nClient.ts**: External integration
- **mcpToolRegistrationService.ts**: Tool management
- **telemetry.ts**: Observability configuration

### Lifecycle State Management
```typescript
// Installation → Terms → Active → Uninstall
isApplicationInstalled: false → true → true → false
termsAndConditionsAccepted: false → false → true → false
```

**Flow**:
1. User installs agent → Welcome message
2. User sends "I accept" → Terms accepted
3. User sends messages → Forwarded to n8n
4. Answer is sent back to user

### Observability-First Design
- All n8n invocations wrapped with InvokeAgentScope
- Inference operations tracked with InferenceScope
- Error recording for debugging
- Proper span disposal in finally blocks

### Graceful Degradation
- MCP tool discovery failures don't block agent
- Empty tool array if discovery fails
- Webhook errors return user-friendly messages
- Fallback responses when n8n unavailable

### Security Best Practices
- JWT authorization on all endpoints
- Environment-based secrets (no hardcoded credentials)
- Optional authentication header for n8n webhook
- Agentic authentication for MCP tool access

---

## 🛠️ Extension Points

### Adding Persistent State
Replace in-memory flags with persistent storage:
```typescript
// Instead of class properties
private stateService: IStateService;

async handleAgentMessageActivity(turnContext, state) {
  const userState = await this.stateService.getUserState(userId);
  if (!userState.termsAccepted) { ... }
}
```

### Custom Notification Types
Add more notification handlers:
```typescript
agentApplication.onAgentNotification("CustomNotificationType",
  async (context, state, notification) => {
    await n8nAgent.handleCustomNotification(context, state, notification);
  }
);
```

### Enhanced Observability
Add custom metrics and tags:
```typescript
scope?.recordCustomMetric('n8n_response_time_ms', duration);
scope?.addTags({ workflow_id: 'xyz', user_tier: 'premium' });
```

### Webhook Response Enrichment
Process structured responses from n8n:
```typescript
interface N8nResponse {
  output: string;
  actions?: string[];
  metadata?: Record<string, any>;
}

// Handle actions, show adaptive cards, etc.
```

## 🔍 Configuration Requirements

### Required Environment Variables
```bash
# Agent Identity
AGENT_ID=your-agent-id
AGENTIC_USER_ID=your-user-id

# n8n Integration
N8N_WEBHOOK_URL=https://your-n8n-instance/webhook/path
N8N_WEBHOOK_AUTH_HEADER="Basic base64credentials"

# Service Connection (Authentication)
connections__service_connection__settings__clientId=<client-id>
connections__service_connection__settings__clientSecret=<client-secret>
connections__service_connection__settings__tenantId=<tenant-id>

# Agentic Authentication
agentic_type=agentic
agentic_altBlueprintConnectionName=service_connection
agentic_scopes=ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default

# MCP Tools (Optional)
MCP_ENVIRONMENT_ID=your-environment-id
MCP_AUTH_TOKEN=optional-bearer-token
TOOLS_MODE=MCPPlatform
```

---

## **Summary**

This n8n agent provides a stateful, observable bridge between Microsoft 365 and n8n workflows. It handles installation lifecycle, enforces terms acceptance, forwards messages and notifications to n8n with MCP tool context, and provides comprehensive telemetry for monitoring and debugging. The architecture separates concerns cleanly, enabling easy extension and maintenance while following Microsoft Agent 365 best practices.


### Features

- **Message handling** from Teams chats with conversation state tracking
- **Installation/uninstallation lifecycle management** with welcome messages
- **Terms and conditions acceptance flow** before agent activation
- **Email notification support** - processes email notifications via agent notifications
- **Word document @-mention support** - handles @-mentions in Word comments via agent notifications
- **MCP Tool Server integration** - discovers and connects to Microsoft 365 MCP tool servers
- **Telemetry and observability** with Agent 365 SDK (InvokeAgentScope, InferenceScope)
- **Graceful shutdown** handling for SIGINT and SIGTERM signals
