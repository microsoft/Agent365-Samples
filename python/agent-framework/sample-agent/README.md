# Agent Framework Sample Agent - Python

This sample demonstrates how to build an agent using Agent Framework in Python with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.x
- Microsoft Agent 365 SDK
- Agent Framework (agent-framework-azure-ai)
- Azure/OpenAI API credentials

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python) guide for complete instructions.

For a detailed explanation of the agent code and implementation, see the [Agent Code Walkthrough](AGENT-CODE-WALKTHROUGH.md).

## Container Deployment

Container deployment is the recommended approach for production Agent 365 workloads. Here's why:

### Why Container Deployment?

**Production Readiness**
- **Consistency**: Containers ensure identical behavior across development, staging, and production environments, eliminating "works on my machine" issues
- **Isolation**: Each agent runs in its own isolated environment with explicit dependencies, preventing conflicts with other services
- **Scalability**: Container orchestrators (Kubernetes, Azure Container Apps) can automatically scale agent instances based on demand

**Azure Integration**
- **Azure Container Apps**: Purpose-built for microservices and agents with built-in autoscaling, managed certificates, and seamless Azure service integration
- **Azure Kubernetes Service (AKS)**: Enterprise-grade orchestration for complex multi-agent deployments
- **Azure Container Registry**: Private registry for secure image storage with geo-replication

**Operational Benefits**
- **Health Checks**: Container runtimes monitor `/api/health` to automatically restart unhealthy agents
- **Rolling Updates**: Deploy new versions with zero downtime using blue-green or canary strategies
- **Resource Limits**: Define CPU/memory boundaries to prevent runaway processes

### Network Binding Fix

This sample binds to `0.0.0.0` (all network interfaces) instead of `localhost`. This is **required** for container deployments because:

- `localhost` (127.0.0.1) only accepts connections from inside the container
- External traffic (Bot Framework messages, health checks) comes from outside the container network
- Binding to `0.0.0.0` allows the agent to receive requests on any network interface

**Symptoms if using localhost in containers:**
- Container starts but health checks fail with "Connection refused"
- Agent works locally but fails when deployed to Docker/Kubernetes/Container Apps
- Bot Framework cannot reach the `/api/messages` endpoint

### Build and run with Docker

```bash
# Navigate to the sample directory first
cd python/agent-framework/sample-agent

# Build the container image
docker build -t python-agent .

# Run with required environment variables
docker run -p 3978:3978 \
  -e AZURE_OPENAI_ENDPOINT=https://your-endpoint.openai.azure.com/ \
  -e AZURE_OPENAI_API_KEY=your-key \
  -e AZURE_OPENAI_DEPLOYMENT=gpt-4o \
  python-agent
```

### Azure Container Apps

```bash
# Navigate to the sample directory
cd python/agent-framework/sample-agent

# Ensure you're logged in to Azure CLI
az login
az account set --subscription <your-subscription-id>

# Build and push to Azure Container Registry
az acr build --registry <your-acr> --image python-agent:latest .

# Create Container App with required environment variables
az containerapp create \
  --name python-agent \
  --resource-group <your-rg> \
  --environment <your-env> \
  --image <your-acr>.azurecr.io/python-agent:latest \
  --target-port 3978 \
  --ingress external \
  --env-vars \
    AZURE_OPENAI_ENDPOINT=https://your-endpoint.openai.azure.com/ \
    AZURE_OPENAI_API_KEY=secretref:openai-key \
    AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Note: For production, use Azure Container Apps secrets for API keys:
# az containerapp secret set --name python-agent --resource-group <your-rg> \
#   --secrets openai-key=<your-actual-api-key>
```

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Agent Framework documentation](https://github.com/microsoft/Agent365-python/tree/main/packages/agent-framework)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.