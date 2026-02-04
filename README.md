# Microsoft Agent 365 SDK Samples and Prompts

[![E2E Tests](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-orchestrator.yml?branch=main&label=E2E%20All%20Samples)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-orchestrator.yml)

This repository contains sample agents and prompts for building with the Microsoft Agent 365 SDK. The Microsoft Agent 365 SDK extends the Microsoft 365 Agents SDK with enterprise-grade capabilities for building sophisticated agents. It provides comprehensive tooling for observability, notifications, runtime utilities, and development tools that help developers create production-ready agents for platforms including M365, Teams, Copilot Studio, and Webchat.

- **Sample agents** are available in C# (.NET), Python, and Node.js/TypeScript
- **Prompts** to help you get started with AI-powered development tools like Cursor IDE

## E2E Test Status

| Sample | Status |
|--------|--------|
| Python OpenAI | [![Python OpenAI](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-python-openai.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-python-openai.yml) |
| Node.js OpenAI | [![Node.js OpenAI](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-nodejs-openai.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-nodejs-openai.yml) |
| Node.js LangChain | [![Node.js LangChain](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-nodejs-langchain.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-nodejs-langchain.yml) |
| .NET Semantic Kernel | [![.NET SK](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-dotnet-semantic-kernel.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-dotnet-semantic-kernel.yml) |
| .NET Agent Framework | [![.NET AF](https://img.shields.io/github/actions/workflow/status/microsoft/Agent365-Samples/e2e-dotnet-agent-framework.yml?branch=main&label=E2E)](https://github.com/microsoft/Agent365-Samples/actions/workflows/e2e-dotnet-agent-framework.yml) |

## SDK Versions

The following SDK packages are used across the samples in this repository. Version badges update automatically from package registries.

### Microsoft Agents SDK Packages

| Package | Version |
|---------|---------|
| `@microsoft/agents-activity` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-activity?label=npm)](https://www.npmjs.com/package/@microsoft/agents-activity) |
| `@microsoft/agents-hosting` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-hosting?label=npm)](https://www.npmjs.com/package/@microsoft/agents-hosting) |
| `microsoft-agents-activity` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-activity?label=pypi)](https://pypi.org/project/microsoft-agents-activity) |
| `microsoft-agents-hosting-core` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-hosting-core?label=pypi)](https://pypi.org/project/microsoft-agents-hosting-core) |
| `microsoft-agents-hosting-aiohttp` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-hosting-aiohttp?label=pypi)](https://pypi.org/project/microsoft-agents-hosting-aiohttp) |
| `microsoft-agents-authentication-msal` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-authentication-msal?label=pypi)](https://pypi.org/project/microsoft-agents-authentication-msal) |
| `Microsoft.Agents.Hosting.AspNetCore` | [![NuGet](https://img.shields.io/nuget/v/Microsoft.Agents.Hosting.AspNetCore?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.Hosting.AspNetCore) |
| `Microsoft.Agents.Authentication.Msal` | [![NuGet](https://img.shields.io/nuget/v/Microsoft.Agents.Authentication.Msal?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.Authentication.Msal) |
| `Microsoft.Agents.AI` | [![NuGet](https://img.shields.io/nuget/vpre/Microsoft.Agents.AI?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.AI) |

### Microsoft Agent 365 SDK Packages

#### Python
| Package | Version |
|---------|---------|
| `microsoft-agents-a365-tooling` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-tooling?label=pypi)](https://pypi.org/project/microsoft-agents-a365-tooling) |
| `microsoft-agents-a365-tooling-extensions-openai` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-tooling-extensions-openai?label=pypi)](https://pypi.org/project/microsoft-agents-a365-tooling-extensions-openai) |
| `microsoft-agents-a365-observability-core` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-observability-core?label=pypi)](https://pypi.org/project/microsoft-agents-a365-observability-core) |
| `microsoft-agents-a365-observability-hosting` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-observability-hosting?label=pypi)](https://pypi.org/project/microsoft-agents-a365-observability-hosting) |
| `microsoft-agents-a365-notifications` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-notifications?label=pypi)](https://pypi.org/project/microsoft-agents-a365-notifications) |
| `microsoft-agents-a365-runtime` | [![PyPI](https://img.shields.io/pypi/v/microsoft-agents-a365-runtime?label=pypi)](https://pypi.org/project/microsoft-agents-a365-runtime) |

#### Node.js
| Package | Version |
|---------|---------|
| `@microsoft/agents-a365-tooling` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-tooling?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-tooling) |
| `@microsoft/agents-a365-tooling-extensions-openai` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-tooling-extensions-openai?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-tooling-extensions-openai) |
| `@microsoft/agents-a365-tooling-extensions-langchain` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-tooling-extensions-langchain?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-tooling-extensions-langchain) |
| `@microsoft/agents-a365-observability` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-observability?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-observability) |
| `@microsoft/agents-a365-observability-hosting` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-observability-hosting?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-observability-hosting) |
| `@microsoft/agents-a365-notifications` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-notifications?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-notifications) |
| `@microsoft/agents-a365-runtime` | [![npm](https://img.shields.io/npm/v/@microsoft/agents-a365-runtime?label=npm)](https://www.npmjs.com/package/@microsoft/agents-a365-runtime) |

#### .NET
| Package | Version |
|---------|---------|
| `Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel` | [![NuGet](https://img.shields.io/nuget/vpre/Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel) |
| `Microsoft.Agents.A365.Tooling.Extensions.AgentFramework` | [![NuGet](https://img.shields.io/nuget/vpre/Microsoft.Agents.A365.Tooling.Extensions.AgentFramework?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.A365.Tooling.Extensions.AgentFramework) |
| `Microsoft.Agents.A365.Observability.Extensions.AgentFramework` | [![NuGet](https://img.shields.io/nuget/vpre/Microsoft.Agents.A365.Observability.Extensions.AgentFramework?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.A365.Observability.Extensions.AgentFramework) |
| `Microsoft.Agents.A365.Notifications` | [![NuGet](https://img.shields.io/nuget/vpre/Microsoft.Agents.A365.Notifications?label=nuget)](https://www.nuget.org/packages/Microsoft.Agents.A365.Notifications) |

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
