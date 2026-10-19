# Microsoft Agent 365 SDK Samples and Prompts

This repository contains sample agents and prompts for building with the Microsoft Agent 365 SDK. The Microsoft Agent 365 SDK extends the Microsoft 365 Agents SDK with enterprise-grade capabilities for building sophisticated agents. It provides comprehensive tooling for observability, notifications, runtime utilities, and development tools that help developers create production-ready agents for platforms including M365, Teams, Copilot Studio, and Webchat.

- **Sample agents** are available in C# (.NET), Python, Node.js/TypeScript, and Salesforce/Apex
- **Prompts** to help you get started with AI-powered development tools like Cursor IDE

## SDK Versions

### Observability S2S export

Agent 365 OBS export uses the S2S `/observabilityService/.../otlp/...` route with an app-only token for the agent instance. This changes telemetry transport only: preserve business MCP/Graph/OBO authentication, development bearer-token flows, and original user/agent baggage.

A live validation on September 28, 2026 showed that a registered agent instance using a roleless app-only token (`idtyp=app`, `roles=[]`, no `scp`) received `200` from `/observabilityService/tenants/{tenant}/otlp/agents/{agent}/traces`. The legacy non-`/otlp` S2S route (`/observabilityService/tenants/{tenant}/agents/{agent}/traces`) rejected the same token with `401` (`AuthenticationSchemeNotSupported`). Every sample must use an SDK/exporter configuration that posts to `/otlp`.

Enable export explicitly and configure the dedicated OBS app-token provider for the runtime agent instance, not the blueprint ID, service-principal object ID, or agent-user ID. The provider accepts app-only tokens with `idtyp=app`, or valid nonempty `roles`, or absent `idtyp` with nonempty `oid == sub`; any `scp` claim is rejected.

The sample providers are single-instance examples: one configured tenant and agent instance, plus a separate blueprint credential. Python and Node.js samples include only a client-secret development flow and no managed-identity option; .NET can use managed-identity assertions. Multi-instance or multi-tenant deployments should cache per agent/tenant and reuse the hosting connection credential. Providers request tokens from `login.microsoftonline.com`; sovereign clouds require provider changes.

AI Teammates should complete the `Agent365.Observability.OtelWrite` application-role step printed by `a365 setup all --aiteammate`; AI Teammate S2S export without that step has not been validated.

See [Agent 365 observability S2S export](docs/observability-s2s.md) for configuration snippets, token contract details, and offline validation commands.

The SDK versions used by each sample are displayed in the **E2E test workflow summaries**. Each E2E run installs the latest compatible packages and logs the resolved versions.

📦 **View SDK Versions**: Click any E2E status badge above, then select a workflow run and view the **"Log SDK Versions"** step in the job summary.

Most samples use flexible version constraints (`>=`, `^`, `*-beta.*`) to pick up
compatible SDK releases. Legacy Node.js samples pin their tested SDK family to
preserve compatible tracing APIs and S2S exporter options.

> #### Note:
> Use the information in this README to contribute to this open-source project. To learn about using this SDK in your projects, refer to the [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Survey

Please help improve the Microsoft Agent 365 SDK and CLI by taking our survey: [Agent365 SDK Integration Feedback Survey](https://forms.office.com/r/wj0edu361y)

## Current Repository State

This samples repository is currently in active development and contains:
- **Sample Agents**: Production-ready examples in C#/.NET, Python, Node.js/TypeScript, and Salesforce/Apex demonstrating observability, notifications, tooling, and hosting patterns
- **Prompts**: Guides for using AI-powered development tools (e.g., Cursor IDE) to accelerate agent development

## Documentation

For comprehensive documentation and guides, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

### Microsoft Agent 365 SDK

The sample agents in this repository use the Microsoft Agent 365 SDK, which provides enterprise-grade extensions for observability, notifications, runtime utilities, and developer tools. Explore the SDK repositories below:

- [Microsoft Agent 365 SDK - C# /.NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft Agent 365 SDK - Node.js/TypeScript repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft Agent 365 SDK Samples repository](https://github.com/microsoft/Agent365-Samples) - You are here

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the Microsoft Open Source Code of Conduct. For more information see the Code of Conduct FAQ or contact opencode@microsoft.com with any additional questions or comments.

## Useful Links

### Microsoft 365 Agents SDK

The core SDK for building conversational AI agents for Microsoft 365 platforms.

- [Microsoft 365 Agents SDK - C# /.NET repository](https://github.com/Microsoft/Agents-for-net)
- [Microsoft 365 Agents SDK - NodeJS /TypeScript repository](https://github.com/Microsoft/Agents-for-js)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Microsoft 365 Agents documentation](https://learn.microsoft.com/microsoft-365/agents-sdk/)

## Additional Resources

For language-specific documentation and additional resources, explore the following links:

- [.NET documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)
- [Node.js documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)
- [Python documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License
Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the LICENSE file for details.
