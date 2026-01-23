# Copilot Studio Sample Agent - Node.js

This sample demonstrates how to integrate a **Microsoft Copilot Studio** agent with the **Microsoft Agent 365 SDK**. It enables enterprise developers to bridge low-code Copilot Studio agents into Agent 365 managed environments with full feature parity.

## Why use this integration?

| Copilot Studio | Agent 365 SDK | Together |
|----------------|---------------|----------|
| Low-code agent building | Enterprise identity (Entra ID) | Best of both worlds |
| Visual flow designer | Microsoft 365 notifications | Low-code agents with enterprise features |
| Built-in connectors | OpenTelemetry observability | Full compliance and monitoring |
| Quick prototyping | Secure Graph access (MCP) | Production-ready deployment |

## Demonstrates

This sample demonstrates:

- **Copilot Studio Integration**: Forward messages to your low-code Copilot Studio agent
- **Notifications**: Handle email notifications from Agent 365 and return responses
- **Observability**: End-to-end tracing with OpenTelemetry spans for Copilot Studio calls
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [@microsoft/agents-copilotstudio-client](https://github.com/microsoft/Agents-for-js/tree/main/packages/agents-copilotstudio-client) package and the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

## Prerequisites

- Node.js 18.x or higher
- Microsoft Agent 365 SDK
- Access to **Microsoft Copilot Studio** (Frontier preview program)
- A published Copilot Studio agent with Web channel enabled
- Azure/Microsoft 365 tenant with administrative permissions

## Copilot Studio Setup

Before running this sample, you need a Copilot Studio agent:

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. Create a new agent (or use an existing one)
3. **Publish** your agent
4. Go to **Settings > Advanced > Metadata** and copy:
   - **Environment ID**
   - **Schema Name** (agent identifier)

   Or copy the **Direct Connect URL** from the agent's channel settings.

## Required Setup Steps

This sample requires additional configuration beyond the standard Agent 365 setup:

### 1. Add CopilotStudio.Copilots.Invoke API Permission

The `CopilotStudio.Copilots.Invoke` scope must be added to your Microsoft Entra ID app registration and blueprint:

1. Go to [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**
2. Select your agent's app registration
3. Go to **API permissions** → **Add a permission**
4. Select **APIs my organization uses** → search for **Power Platform API** or **Dataverse**
5. Add the `CopilotStudio.Copilots.Invoke` delegated permission
6. Grant admin consent for the permission
7. Update your blueprint to include this scope in the allowed permissions

### 2. Grant User Access to the Copilot Studio Agent

Users must have access to chat with your Copilot Studio agent:

- **Option A: Organization-wide access** (used in this sample)
  1. Open your agent in Copilot Studio
  2. Click **… (three dots)** → **Share**
  3. Select the option to share with everyone in your organization

- **Option B: Security group access**
  1. Create a security group in Microsoft Entra ID
  2. Add users who need access to the group
  3. Share the agent with that security group in Copilot Studio

> **Note:** Individual users cannot be granted access directly—you must use security groups or organization-wide sharing. Authentication must be configured with **Microsoft Entra ID** and **"Require users to sign in"** enabled.

For more details, see [Share agents with other users](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots).

### 3. Microsoft 365 Copilot License Requirement

A **Microsoft 365 Copilot license** is required to publish agents in Copilot Studio. Ensure your tenant has the appropriate licensing before attempting to publish your agent.

### 4. Agentic Authentication with Power Platform Audience

This sample uses the agentic authentication flow to request a token with the **Power Platform audience** (`https://api.powerplatform.com/.default`). This token is required to access and invoke Copilot Studio agents.

```js
// Acquire token for Copilot Studio API
const tokenResult = await authorization.exchangeToken(turnContext, authHandlerName, {
   scopes: ['https://api.powerplatform.com/.default']
});
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
# Option 1: Direct Connect URL (recommended)
directConnectUrl=https://your-copilot.api.powerplatform.com/...

# Option 2: Environment ID + Agent Identifier
environmentId=your-environment-id
agentIdentifier=your-agent-schema-name

# Agent 365 Service Connection
connections__service_connection__settings__clientId=<<BLUEPRINT_CLIENT_ID>>
connections__service_connection__settings__clientSecret=<<BLUEPRINT_CLIENT_SECRET>>
connections__service_connection__settings__tenantId=<<TENANT_ID>>
```

### Getting the Connection String

1. In Copilot Studio, open your published agent
2. Go to **Settings > Channels > Custom website**
3. Copy the connection details (Environment ID and Schema Name)
4. Alternatively, use the Direct Connect URL if available

## How to run this sample

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your Copilot Studio and Agent 365 settings
   ```

3. **Run in development mode**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   npm start
   ```

The agent will start listening on `http://localhost:3978/api/messages`.

## Testing

### Local Testing with Playground

```bash
npm run test-tool
```

This launches the Microsoft 365 Agents Playground for local testing.

## Troubleshooting

### Missing API keys or environment variables

**Error:** `Error: Missing required environment variable: COPILOT_STUDIO_SCHEMA_NAME`

**Solution:** Ensure you've copied `.env.template` to `.env` and filled in all required values:
```bash
cp .env.template .env
# Edit .env and add your Copilot Studio agent details
```

### Authentication errors

**Error:** `401 Unauthorized` when connecting to Copilot Studio

**Solution:** 
- Verify that `CopilotStudio.Copilots.Invoke` permission is added to your Entra ID app registration
- Ensure the permission is granted admin consent
- Check that your agent ID and environment ID are correct
- Verify your Microsoft 365 credentials have access to the Copilot Studio agent

### Connection failures to Copilot Studio

**Error:** `ECONNREFUSED` or timeout errors when sending messages

**Solution:**
- Verify your Copilot Studio agent is published
- Check that the Web channel is enabled in Copilot Studio
- Ensure your `COPILOT_STUDIO_ENVIRONMENT_ID` and `COPILOT_STUDIO_SCHEMA_NAME` are correct
- Try copying the Direct Connect URL from Copilot Studio settings and using it to configure your environment variables

### TypeScript compilation errors

**Error:** `Cannot find module '@microsoft/agents-copilotstudio-client'`

**Solution:**
```bash
# Clean install dependencies
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Port already in use

**Error:** `EADDRINUSE: address already in use :::3978`

**Solution:**
```bash
# Find and kill the process using port 3978
lsof -ti:3978 | xargs kill -9
# Or change the port in your .env file
PORT=3979
```

### Module not found errors at runtime

**Error:** `Cannot find module` errors when running the agent

**Solution:**
```bash
# Ensure TypeScript is compiled
npm run build
# Then start the agent
npm start
```

## Extending this sample

### Adding multi-turn conversation support

The current implementation is stateless. To maintain conversation context:

```typescript
// Store conversation ID in state
state.setValue('conversation.conversationId', activity.conversation.id);

// Retrieve for subsequent messages
const conversationId = state.getValue<string>('conversation.conversationId');
```

### Adding Teams notification support

```typescript
// In agent.ts, add to handleAgentNotificationActivity:
case NotificationType.TeamsNotification:
  await this.handleTeamsNotification(context, state, agentNotificationActivity);
  break;
```

### Adding streaming responses

```typescript
// In client.ts, modify to stream responses:
for await (const activity of client.sendActivityStreaming(userActivity)) {
  if (activity.type === ActivityTypes.Typing) {
    await context.sendActivity(new Activity(ActivityTypes.Typing));
  } else if (activity.type === ActivityTypes.Message) {
    await context.sendActivity(activity);
  }
}
```

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Agent 365 SDK  │      │   This Sample    │      │  Copilot Studio     │
│  (Notifications)│─────>│   (MyAgent)      │─────>│  (Your Low-code     │
└─────────────────┘      └──────────────────┘      │   Agent)            │
        │                        │                 └─────────────────────┘
        │   Email notification   │                          │
        │───────────────────────>│   Forward message        │
        │                        │─────────────────────────>│
        │                        │                          │
        │                        │   Agent response         │
        │                        │<─────────────────────────│
        │   Email response       │                          │
        │<───────────────────────│                          │
```

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Copilot Studio**: See [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- **Security**: For security issues, please see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [@microsoft/agents-copilotstudio-client package](https://github.com/microsoft/Agents-for-js/tree/main/packages/agents-copilotstudio-client)
- [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
