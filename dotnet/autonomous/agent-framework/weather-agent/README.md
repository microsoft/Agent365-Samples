# Autonomous Weather Agent — Agent Framework Sample

## Overview

This sample demonstrates an **autonomous agent** built with the [Agent Framework](https://github.com/microsoft/agent-framework) and the Microsoft Agent 365 SDK. It combines two patterns:

- **Autonomous background behavior**: A `WeatherMonitorService` polls real-time weather conditions every 60 seconds and uses Azure OpenAI to generate a field operations advisory — with no user interaction required.
- **Conversational chat**: A `/api/messages` endpoint handles incoming messages, allowing users to ask weather questions for any city worldwide. Responses are streamed back using the Agent Framework streaming API.

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet) and is suitable for **non-M365 (non-Teams) deployments** via the A365 Playground.

For comprehensive documentation on building agents with the Microsoft Agent 365 SDK, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Autonomous background service with LLM | `WeatherMonitorService.cs` |
| Periodic heartbeat service | `HeartbeatService.cs` |
| Streaming conversational chat | `Agent/DotNetAutonomousAgent.cs` |
| AI function tool (geocoding + weather fetch) | `Tools/WeatherLookupTool.cs` |
| Conversation history across turns | `Agent/DotNetAutonomousAgent.cs` — `GetOrCreateThread` |
| JWT bearer token validation | `AspNetExtensions.cs` |

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or higher
- An Azure OpenAI resource with a `gpt-4o` deployment (or update `AzureOpenAI:Deployment` in `appsettings.json`)
- A registered bot application (Azure AD App Registration) for the `ServiceConnection` settings

## Configuration

Copy `appsettings.json` and replace the `{{...}}` placeholders with your values:

| Placeholder | Description |
|-------------|-------------|
| `{{BOT_APP_ID}}` | Azure AD App Registration ID for the agent |
| `{{BOT_APP_PASSWORD}}` | Client secret for the app registration |
| `{{BOT_TENANT_ID}}` | Azure AD tenant ID |
| `{{AZURE_OPENAI_ENDPOINT}}` | Azure OpenAI resource endpoint URL |
| `{{AZURE_OPENAI_API_KEY}}` | Azure OpenAI API key |

You can also use [.NET User Secrets](https://learn.microsoft.com/aspnet/core/security/app-secrets) or environment variables to supply these values without modifying `appsettings.json`.

The `WeatherMonitor` section controls the default location for the autonomous monitoring service:

```json
"WeatherMonitor": {
  "City": "Seattle, WA",
  "Latitude": "47.6062",
  "Longitude": "-122.3321"
}
```

Weather data is fetched from [Open-Meteo](https://open-meteo.com/) — no API key required.

## Running the Agent

```bash
dotnet run --project weather-agent/AgentFrameworkAutonomousAgent.csproj
```

Or open `AgentFrameworkAutonomousAgent.sln` in Visual Studio and press F5.

The agent starts on `http://localhost:3978` in Development mode. Console output will show:

- **Heartbeat** log every 60 seconds
- **Weather advisory** log every 60 seconds (autonomous behavior)
- **Incoming message** logs when chat messages are received

## Testing

### Local — Bot Framework Emulator

1. Install the [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator/releases)
2. Run the agent locally
3. Open Emulator → **New Bot** → URL: `http://localhost:3978/api/messages`
4. Send a message — no authentication required (`TokenValidation.Enabled: false` in development)

Example queries:
- *"What is the weather in Chennai?"*
- *"Is it good weather for outdoor work in London?"*
- *"Compare the weather in Seattle and Tokyo"*

### Local — A365 Playground via Dev Tunnel

1. Run the agent locally
2. Create a [VS Code Dev Tunnel](https://code.visualstudio.com/docs/editor/port-forwarding) to expose port 3978
3. Update the messaging endpoint in A365 portal to `https://<tunnel-url>/api/messages`
4. Open A365 Playground → select the agent → chat

### Deployed — A365 Playground

After deploying to Azure (App Service, Container Apps, etc.):

1. Update the messaging endpoint in A365 portal to `https://<your-host>/api/messages`
2. Set `TokenValidation.Enabled: true` and configure `BOT_APP_ID` / `BOT_APP_PASSWORD`
3. Open A365 Playground → select the agent → chat

## Handling Agent Install and Uninstall

When an agent is installed or uninstalled, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `DotNetAutonomousAgent.cs`:

```csharp
if (tc.Activity.Action == InstallationUpdateActionTypes.Add)
    await tc.SendActivityAsync(MessageFactory.Text("Agent installed successfully."), ct);
else if (tc.Activity.Action == InstallationUpdateActionTypes.Remove)
    await tc.SendActivityAsync(MessageFactory.Text("Agent uninstalled."), ct);
```

## Support

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-dotnet/issues)
- **Documentation**: [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: See [SECURITY.md](../../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA). For details, visit <https://cla.opensource.microsoft.com>.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
