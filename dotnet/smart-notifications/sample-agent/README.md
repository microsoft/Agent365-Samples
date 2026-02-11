# Task Personalization Sample Agent - C#/.NET (Semantic Kernel)

This sample demonstrates how to build a task personalization agent using Semantic Kernel in C#/.NET with the Microsoft Agent 365 SDK. It extends the base Semantic Kernel sample with a **Trigger Evaluation Framework** for personalized notification processing. It covers:

- **Task Personalization**: Trigger-based evaluation of notifications (email, document comments, messages) with personalized instructions
- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications with trigger-matched instructions
- **Tools**: Model Context Protocol tools including `mcp_TaskPersonalizationServer` for trigger evaluation
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK
- **Security**: Instruction sanitization to prevent prompt injection in trigger instructions

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- .NET 8.0 or higher
- Microsoft Agent 365 SDK
- Semantic Kernel 1.66.0 or higher
- Azure/OpenAI API credentials

## Launch Profiles

This sample includes two launch profiles in `Properties/launchSettings.json`:

### Sample Agent

Uses Agentic Users with Client Credentials or Managed Identity. Use this for production or when testing with full Azure Bot Service configuration.

### Sample Agent with Bearer Token Support

Simplified profile for early local development using bearer token authentication.

**Quick setup:**
1. Add required permissions using the a365 CLI:
   ```bash
   a365 develop add-permissions
   ```
   This grants the necessary scopes for MCP tool access.

2. Get a bearer token:
   ```bash
   a365 develop get-token
   ```
   The CLI will either automatically add the token to your `launchSettings.json` or provide it for you to copy/paste.

3. Select the "Sample Agent with Bearer Token Support" launch profile in Visual Studio
4. Run the agent

> **Note**: Bearer tokens are for development only and expire regularly. Refresh with `a365 develop get-token`.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=dotnet) guide for complete instructions.

For a detailed explanation of the agent code and implementation, see the [Agent Code Walkthrough](Agent-Code-Walkthrough.md).

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-dotnet/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - .NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Semantic Kernel documentation](https://learn.microsoft.com/semantic-kernel/)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
