# Microsoft Agent 365 SDK Samples and Prompts

[![E2E Tests](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-orchestrator.yml?branch=main&label=E2E%20All%20Samples)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-orchestrator.yml)

This repository contains sample agents and prompts for building with the Microsoft Agent 365 SDK. The Microsoft Agent 365 SDK extends the Microsoft 365 Agents SDK with enterprise-grade capabilities for building sophisticated agents. It provides comprehensive tooling for observability, notifications, runtime utilities, and development tools that help developers create production-ready agents for platforms including M365, Teams, Copilot Studio, and Webchat.

- **Sample agents** are available in C# (.NET), Python, and Node.js/TypeScript
- **Prompts** to help you get started with AI-powered development tools like Cursor IDE

## E2E Test Status

| Sample | Status |
|--------|--------|
| Python OpenAI | [![Python OpenAI](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-python-openai.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-python-openai.yml) |
| Python Agent Framework | [![Python AF](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-python-agent-framework.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-python-agent-framework.yml) |
| Python Google ADK | [![Python Google ADK](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-python-google-adk.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-python-google-adk.yml) |
| Node.js OpenAI | [![Node.js OpenAI](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-nodejs-openai.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-nodejs-openai.yml) |
| Node.js LangChain | [![Node.js LangChain](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-nodejs-langchain.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-nodejs-langchain.yml) |
| Node.js Copilot Studio | [![Node.js Copilot Studio](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-nodejs-copilot-studio.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-nodejs-copilot-studio.yml) |
| .NET Semantic Kernel | [![.NET SK](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-dotnet-semantic-kernel.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-dotnet-semantic-kernel.yml) |
| .NET Agent Framework | [![.NET AF](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-dotnet-agent-framework.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-dotnet-agent-framework.yml) |

## SDK Versions

The following SDK package versions are used across the samples in this repository. This section is automatically updated when package versions change.

<!-- SDK_VERSIONS_START -->

### Microsoft Agents SDK Packages

| Package | Version |
|---------|---------|
| `@microsoft/agents-activity` | `1.2.2` |
| `@microsoft/agents-hosting` | `1.2.2` |
| `Microsoft.Agents.AI` | `1.0.0-preview.251113.1` |
| `Microsoft.Agents.Authentication.Msal` | `1.3.*-*` |
| `Microsoft.Agents.Hosting.AspNetCore` | `1.3.*-*` |

### Microsoft Agent 365 SDK Packages

#### Python
| Package | Version |
|---------|---------|
| `microsoft_agents_a365_notifications` | `0.1.0` |
| `microsoft_agents_a365_observability_core` | `0.1.0` |
| `microsoft_agents_a365_observability_extensions_openai` | `0.1.0` |
| `microsoft_agents_a365_runtime` | `0.1.0` |
| `microsoft_agents_a365_tooling` | `0.1.0` |
| `microsoft_agents_a365_tooling_extensions_openai` | `0.1.0` |
| `microsoft-agents-a365-observability-core` | `0.1.0` |
| `microsoft-agents-a365-observability-hosting` | `0.2.0` |
| `microsoft-agents-a365-tooling` | `0.1.0` |

#### Node.js
| Package | Version |
|---------|---------|
| `@microsoft/agents-a365-notifications` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-observability` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-observability-extensions-openai` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-observability-hosting` | `0.1.0-preview.64` |
| `@microsoft/agents-a365-runtime` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-tooling` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-tooling-extensions-langchain` | `0.1.0-preview.30` |
| `@microsoft/agents-a365-tooling-extensions-openai` | `0.1.0-preview.30` |

#### .NET
| Package | Version |
|---------|---------|
| `Microsoft.Agents.A365.Notifications` | `*-beta.*` |
| `Microsoft.Agents.A365.Observability.Extensions.AgentFramework` | `*-beta.*` |
| `Microsoft.Agents.A365.Tooling.Extensions.AgentFramework` | `*-beta.*` |
| `Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel` | `*-beta.*` |

<!-- SDK_VERSIONS_END -->

> #### Note:
> Use the information in this README to contribute to this open-source project. To learn about using this SDK in your projects, refer to the [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Survey

Please help improve the Microsoft Agent 365 SDK and CLI by taking our survey: [Agent365 SDK Integration Feedback Survey](https://forms.office.com/r/wj0edu361y)

## Current Repository State

This samples repository is currently in active development and contains:
- **Sample Agents**: Production-ready examples in C#/.NET, Python, and Node.js/TypeScript demonstrating observability, notifications, tooling, and hosting patterns
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
