# Code Walkthrough: LangChain Sample Agent

This document provides a detailed technical walkthrough of the simplified LangChain Sample Agent implementation, covering architecture, key components, and design decisions.

## 📁 File Structure Overview

```
sample-agent/
├── src/
│   ├── agent.ts               # 🔵 Main agent implementation (40 lines)
│   ├── client.ts              # 🔵 LangChain client factory and wrapper
│   └── index.ts               # 🔵 Express server entry point
├── ToolingManifest.json       # 🔧 MCP tools definition (unused)
├── package.json               # 📦 Dependencies and scripts
├── tsconfig.json              # 🔧 TypeScript configuration
├── .env.example               # ⚙️ Environment template
└── Documentation files...
```

## 🏗️ Architecture Overview

### Design Principles
1. **LangChain Integration**: Uses basic LangChain agents
2. **Event-Driven**: Bot Framework activity handlers for message types
3. **Simplified**: Minimal implementation without advanced features

### Key Components
```
┌─────────────────────────────────────────────────────┐
│                agent.ts Structure                   │
├─────────────────────────────────────────────────────┤
│  Imports & Dependencies              (Lines 1-5)    │
│  A365Agent Class                    (Lines 7-40)    │
│   ├── Constructor & Event Routing  (Lines 13-19)    │
│   └── Message Activity Handler     (Lines 21-37)    │
│  Agent Application Export          (Line 40)        │
└─────────────────────────────────────────────────────┘
```

## 🔍 Core Components Deep Dive

### 1. A365Agent Class

**Location**: Lines 7-40

#### 1.1 Constructor and Event Routing (Lines 13-19)
```typescript
constructor() {
  super();

  this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
    await this.handleAgentMessageActivity(context, state);
  });

  // Route agent notifications
  this.onAgentNotification("*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
    await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
  });
}
```

**Key Features**:
- **Message Activity Routing**: Registers handler for message activities
- **Notification Handling**: Routes agent notifications with wildcard pattern
- **Bot Framework Integration**: Uses standard TurnState with event handlers

#### 1.2 Message Activity Handler (Lines 21-37)
```typescript
async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
  const userMessage = turnContext.activity.text?.trim() || '';

  if (!userMessage) {
    await turnContext.sendActivity('Please send me a message and I\'ll help you!');
    return;
  }

  try {
    const client: Client = await getClient();
    const response = await client.invokeAgentWithScope(userMessage);
    await turnContext.sendActivity(response);
  } catch (error) {
    console.error('LLM query error:', error);
    const err = error as any;
    await turnContext.sendActivity(`Error: ${err.message || err}`);
  }
}
```

**Process Flow**:
1. **Input Validation**: Checks for non-empty user message
2. **Client Creation**: Gets a LangChain client with MCP tools
3. **Message Processing**: Passes user input to agent with observability scope
4. **Response**: Returns AI-generated response with telemetry tracking
5. **Error Handling**: Provides user-friendly error messages

#### 1.3 Agent Notification Handler
```typescript
async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity): Promise<void> {
  await context.sendActivity("Received an AgentNotification!");
  /* your logic here... */
}
```

**Notification Processing**:
- **Event Recognition**: Receives and processes agent notification activities
- **Response Handling**: Sends acknowledgment message
- **Extensibility**: Placeholder for custom notification logic

## 🔧 Supporting Files

### 1. client.ts - LangChain Integration

**Purpose**: Factory and wrapper for LangChain agents with MCP tool integration

**Key Components**:

#### A. Imports and Setup
```typescript
import { ClientConfig } from '@langchain/mcp-adapters';
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-langchain';

import {
  InferenceScope,
} from '@microsoft/agents-a365-observability';

// Observability is initialized by the Microsoft OpenTelemetry distro in index.ts.
// See: https://github.com/microsoft/opentelemetry-distro-javascript

const toolService = new McpToolRegistrationService();
```

**Tooling Service**:
- **MCP Integration**: Initializes service for MCP tool servers
- **A365 Extensions**: Uses Microsoft 365 tooling extensions for LangChain

#### B. Client Factory Function
```typescript
export async function getClient(authorization: any, turnContext: TurnContext): Promise<Client> {
  // Get Mcp Tools
  let tools: DynamicStructuredTool[] = [];

  try {
    const mcpClientConfig = {} as ClientConfig;
    tools = await toolService.addMcpToolServers(
      mcpClientConfig,
      '',
      authorization,
      turnContext,
      process.env.BEARER_TOKEN || "",
    );
  } catch (error) {
    console.error('Error adding MCP tool servers:', error);
  }

  // Create the model
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
  });

  // Create the agent
  const agent = createAgent({
    model: model,
    tools: tools,
    name: 'LangChain Agent',
    includeAgentName: 'inline'
  });

  return new LangChainClient(agent);
}
```

**LangChain Integration**:
- **MCP Tools**: Loads tools from MCP tool servers dynamically
- **Auth**: Uses `BEARER_TOKEN` for authentication
- **OpenAI Model**: Configured for GPT-4o-mini
- **Error Handling**: Gracefully handles tool loading failures

**Authentication Options**:

1. **OBO (On-Behalf-Of) Authentication**:
```
BEARER_TOKEN=<your-mcp-bearer-token>
```

2. **Agentic Authentication**:
```
USE_AGENTIC_AUTH=true

connections__service_connection__settings__clientId=<client-id>
connections__service_connection__settings__clientSecret=<client-secret>
connections__service_connection__settings__tenantId=<tenant-id>

connectionsMap__0__serviceUrl=*
connectionsMap__0__connection=service_connection

agentic_altBlueprintConnectionName=service_connection
agentic_scopes=ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default
```

#### B. LangChainClient Wrapper
```typescript
class LangChainClient implements Client {
  private agent: any;

  constructor(agent: any) {
    this.agent = agent;
  }

  async invokeAgent(userMessage: string): Promise<string> {
    const result = await this.agent.invoke({
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    let agentMessage = '';

    // Extract the content from the LangChain response
    if (result.messages && result.messages.length > 0) {
      const lastMessage = result.messages[result.messages.length - 1];
      agentMessage = lastMessage.content || "No content in response";
    }

    // Fallback if result is already a string
    if (typeof result === 'string') {
      agentMessage = result;
    }

    if (!agentMessage) {
      return "Sorry, I couldn't get a response from the agent :(";
    }

    return agentMessage;
  }

  async invokeInferenceScope(prompt: string) {
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: "gpt-4o-mini",
    };

    const agentDetails: AgentDetails = {
      agentId: 'typescript-compliance-agent',
      agentName: 'TypeScript Compliance Agent',
      conversationId: 'conv-12345',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'typescript-sample-tenant',
    };

    let response = '';
    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
    try {
      await scope.withActiveSpanAsync(async () => {
      response = await this.invokeAgent(prompt);
      // Record the inference response with token usage
      scope.recordOutputMessages([response]);
      scope.recordInputMessages([prompt]);
      scope.recordResponseId(`resp-${Date.now()}`);
      scope.recordInputTokens(45);
      scope.recordOutputTokens(78);
      scope.recordFinishReasons(['stop']);
      });      
    } catch (error) {
      scope.recordError(error as Error);
      throw error;
    } finally {
      scope.dispose();
    }
    return response;
  }
}
```

**Response Processing**:
- **Message Extraction**: Parses LangChain's message format
- **Content Handling**: Extracts text content from response structure
- **Fallback Logic**: Handles various response formats gracefully
- **Error Reporting**: Provides meaningful error messages

**Observability Integration**:
- **Inference Scoping**: Wraps agent invocations with observability tracking
- **Token Tracking**: Records input/output tokens for monitoring
- **Agent Details**: Captures agent ID, name, and conversation context
- **Tenant Context**: Associates operations with tenant for multi-tenancy support

**Client Interface**:
```typescript
export interface Client {
  invokeAgentWithScope(prompt: string): Promise<string>;
}
```

### 2. index.ts - Express Server

**Purpose**: HTTP server entry point with Bot Framework integration

**Features**:
- **Environment Loading**: Loads configuration from `.env` files
- **Authentication**: JWT-based authorization middleware using `loadAuthConfigFromEnv()`
- **Bot Framework**: CloudAdapter for handling Bot Framework messages
- **Simplified Setup**: Basic server without advanced telemetry

### 3. ToolingManifest.json

**Purpose**: MCP tools configuration for connecting to external tool servers

**Configuration Requirements**:
- Must be located in the current working directory (cwd)
- Should include at least one MCP server definition
- Tools are dynamically loaded at runtime via `McpToolRegistrationService`

**Integration**:
- The client reads this manifest to discover available MCP tool servers
- Tools are registered with the LangChain agent during client initialization

## 🎯 Design Patterns and Best Practices

### 1. Factory Pattern

**Implementation**:
- Client factory creates basic LangChain agents
- Separation of concerns between agent and client logic

**Benefits**:
- Testability through dependency injection
- Clean separation of LangChain specifics

### 2. Event-Driven Architecture

**Bot Framework Integration**:
```typescript
this.onActivity(ActivityTypes.Message, async (context, state) => {
  await this.handleAgentMessageActivity(context, state);
});

this.onAgentNotification("*", async (context, state, agentNotificationActivity) => {
  await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
});
```

**Benefits**:
- Scalable message handling
- Type-safe event routing
- Notification support for asynchronous agent events

### 3. Observability Pattern

**Scope-Based Tracking**:
```typescript
const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
// ... perform inference ...
scope?.recordOutputMessages([response]);
scope?.recordInputMessages([prompt]);
```

**Benefits**:
- Comprehensive telemetry capture
- Performance monitoring
- Token usage tracking
- Multi-tenant context preservation

## 🔍 Current Limitations

### 1. Static Token Recording
- Token counts are currently hardcoded in observability tracking
- Should be replaced with actual token usage from LangChain responses

### 2. Basic Notification Handling
- Notification handler provides acknowledgment only
- Custom business logic needs to be implemented

### 3. Environment Configuration
- Requires proper setup of environment variables for MCP and authentication
- Multiple authentication modes need careful configuration

## 🛠️ Extension Points

### 1. Adding Custom Tools
To add additional tools to the agent, extend the MCP configuration in `ToolingManifest.json` or programmatically add tools to the array in `client.ts`.

### 2. Enhanced Observability
The observability scope can be extended with additional metrics:
```typescript
scope?.recordCustomMetric('metric-name', value);
scope?.addTags({ key: 'value' });
```

### 3. Advanced Notification Logic
Implement custom business logic in `handleAgentNotificationActivity`:
```typescript
async handleAgentNotificationActivity(context, state, agentNotificationActivity) {
  // Parse notification payload
  // Execute business logic
  // Send appropriate responses
}
```

### 4. Additional Activity Handlers
New handlers can be added in the constructor:
```typescript
this.onActivity(ActivityTypes.InstallationUpdate, async (context, state) => {
  // Handle installation events
});
```

## 📊 Current Capabilities

### 1. Conversational AI with Tools
- Handles user messages with LangChain agent
- Dynamically loads MCP tools for extended functionality
- Generates AI responses using GPT-4o-mini
- Provides error feedback

### 2. Bot Framework Integration
- Works with Microsoft Bot Framework
- Supports standard messaging protocols
- Handles authentication through Express middleware
- Processes agent notifications

### 3. Observability and Monitoring
- Tracks inference operations with detailed telemetry
- Records token usage and performance metrics
- Maintains tenant and agent context
- Provides service-level monitoring

## 🔄 Potential Enhancements

### 1. Dynamic Token Tracking
- Replace hardcoded token counts with actual usage from LangChain
- Implement token consumption analysis and optimization

### 2. Advanced Notification Workflows
- Build complex notification routing logic
- Add notification persistence and retry mechanisms
- Implement notification filtering and prioritization

### 3. Enhanced State Management
- Add conversation history tracking
- Implement custom state interfaces for complex scenarios
- Add state persistence mechanisms

### 4. Authentication Enhancements
- Support additional authentication providers
- Implement token refresh mechanisms
- Add fine-grained access control

---

**Summary**: This LangChain agent implementation provides conversational AI capabilities through the Microsoft Bot Framework with integrated MCP tooling, observability tracking, and notification handling. The agent dynamically loads tools from MCP servers, tracks inference operations with comprehensive telemetry, and supports both message-based interactions and asynchronous agent notifications.