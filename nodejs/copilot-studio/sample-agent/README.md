# Copilot Studio Sample Agent - Node.js

This sample demonstrates how to integrate a **Microsoft Copilot Studio** agent with the **Microsoft Agent 365 SDK**. It enables enterprise developers to bridge low-code Copilot Studio agents into Agent 365 managed environments with full feature parity.

## Why use this integration?

| Copilot Studio | Agent 365 SDK | Together |
|----------------|---------------|----------|
| Low-code agent building | Enterprise identity (Entra ID) | Best of both worlds |
| Visual flow designer | Microsoft 365 notifications | Low-code agents with enterprise features |
| Built-in connectors | OpenTelemetry observability | Full compliance and monitoring |
| Quick prototyping | Secure Graph access (MCP) | Production-ready deployment |

This sample covers:

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

### Testing with Dev Tunnels

For testing with external services or Teams:

1. Install [VS Code Dev Tunnels extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server)
2. Create a tunnel: `devtunnel create --allow-anonymous`
3. Start the tunnel: `devtunnel port create -p 3978`
4. Update your bot messaging endpoint with the tunnel URL

For complete testing instructions, see [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs).

## Troubleshooting

### Common Issues

**"Failed to acquire token for Copilot Studio"**
- Ensure your service connection is properly configured
- Verify the user has signed in and granted consent
- Check that the Copilot Studio agent allows external client integration

**"No response from Copilot Studio agent"**
- Verify your Copilot Studio agent is **published** (not just saved)
- Check that the Environment ID and Schema Name are correct
- Ensure the agent's Web channel is enabled

**"Connection refused" or network errors**
- Verify the `directConnectUrl` or `environmentId`/`agentIdentifier` are correct
- Check network connectivity to `api.powerplatform.com`
- Ensure your firewall allows outbound HTTPS connections

**Authentication errors (401/403)**
- Verify your tenant ID matches the Copilot Studio agent's tenant
- Check that the app registration has `CopilotStudio.Copilots.Invoke` permission
- Ensure the service connection credentials are correct

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
