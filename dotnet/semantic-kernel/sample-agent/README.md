# Agent 365 Sample Agent - .NET Semantic Kernel

This directory contains a sample agent implementation using .NET and Semantic Kernel, hosted on an ASP.NET Core web service. This agent will handle multiple "turns" to get the required information from the user.

This Agent Sample is intended to introduce you to the basics of integrating Agent 365 and Semantic Kernel with the Microsoft 365 Agents SDK in order to build powerful Agents. It can also be used as the base for a custom Agent that you choose to develop.

## Demonstrates

This sample demonstrates how to build an agent using the Agent 365 framework with .NET and Semantic Kernel. It shows the three key Agent 365 concepts; Notifications, Observability, and Tooling, and shows how by combining these concepts, powerful scenarios can be unlocked.

## Prerequisites

- [.NET 8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)+
- Azure OpenAI or OpenAI API key
- Optional: [Microsoft 365 Agents Playground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project)
- Optional: [dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started)

## How to run this sample

### Configuration

1. You will need an Azure OpenAI or OpenAI resource using, e.g., model `gpt-4o-mini`
2. Configure OpenAI in `appsettings.json`
    ```json
    "AIServices": {
      "AzureOpenAI": {
        "DeploymentName": "", // This is the Deployment (as opposed to model) Name of the Azure OpenAI model
        "Endpoint": "", // This is the Endpoint of the Azure OpenAI model deployment
        "ApiKey": "" // This is the API Key of the Azure OpenAI model deployment
      },
      "OpenAI": {
        "ModelId": "", // This is the Model ID of the OpenAI model
        "ApiKey": "" // This is the API Key of the OpenAI model
      },
      "UseAzureOpenAI": true // This is a flag to determine whether to use the Azure OpenAI model or the OpenAI model
    }
    ```
3. For information on how to create an Azure OpenAI deployment, see [Create and deploy an Azure OpenAI in Azure AI Foundry Models resource](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/create-resource?pivots=web-portal).
4. Verify the local development settings in `Properties/launchSettings.json` are configured for your environment.

### Run using Microsoft 365 Agents Playground

1. If you haven't done so already, install the Agents Playground:
   ```bash
   winget install agentsplayground
   ```
2. Start the agent in Visual Studio or VS Code in debug mode
3. Start Agents Playground at a command prompt:
   ```bash
   agentsplayground
   ```
   The tool will open a web browser showing the Microsoft 365 Agents Playground, ready to send messages to your agent.
4. Interact with the agent via the browser


### Run using WebChat or Teams

**Overview of running and testing an agent:**
- Provision an Azure Bot in your Azure Subscription
- Configure your agent settings to use the desired authentication type
- Run an instance of the agent app (either locally or deployed to Azure)
- Test in a client

#### Setup

1. Create an Azure Bot with one of these authentication types
   - [SingleTenant, Client Secret](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/azure-bot-create-single-secret)
   - [SingleTenant, Federated Credentials](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/azure-bot-create-federated-credentials) 
   - [User Assigned Managed Identity](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/azure-bot-create-managed-identity)
    
   > **Note:** Be sure to follow the **Next Steps** at the end of these docs to configure your agent settings.

   > **IMPORTANT:** If you want to run your agent locally via devtunnels, the only supported auth type is Client Secrets and Certificates.

2. Running the agent

   **Option A: Run the agent locally**
   
   - Requires a tunneling tool to allow for local development and debugging when connected to an external client such as Microsoft Teams.
   - **For Client Secret or Certificate authentication types only.** Federated Credentials and Managed Identity will not work via a tunnel to a local agent and must be deployed to an App Service or container.
   
   Steps:
   1. Run `dev tunnels`. Follow [Create and host a dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started?tabs=windows) and host the tunnel with anonymous user access as shown below:
      ```bash
      devtunnel host -p 3978 --allow-anonymous
      ```
   2. On the Azure Bot, select **Settings**, then **Configuration**, and update the **Messaging endpoint** to `{tunnel-url}/api/messages`
   3. Start the agent in Visual Studio

   **Option B: Deploy agent code to Azure**
   
   1. Deploy using Visual Studio Publish or any tool used to deploy web applications.
   2. On the Azure Bot, select **Settings**, then **Configuration**, and update the **Messaging endpoint** to `https://{{appServiceDomain}}/api/messages`

#### Testing this agent with WebChat

1. Select **Test in WebChat** on the Azure Bot resource in the Azure portal

#### Testing this agent in Teams or Microsoft 365

1. Update the `manifest.json` file:
   - Edit the `manifest.json` file in the `appManifest` folder
     - Replace `<<AAD_APP_CLIENT_ID>>` with your AppId (created above) *everywhere* it appears
     - Replace `<<BOT_DOMAIN>>` with your agent URL (for example, the tunnel host name)
   - Zip the contents of the `appManifest` folder to create `manifest.zip` (include all three files):
     - `manifest.json`
     - `outline.png`
     - `color.png`
2. Ensure your Azure Bot has the **Microsoft Teams** channel added under **Channels**.
3. Navigate to the Microsoft 365 admin center. Under **Settings** and **Integrated Apps**, select **Upload Custom App**.
4. Select the `manifest.zip` file created in the previous step.
5. After a short period, the agent will appear in Microsoft Teams and Microsoft 365 Copilot.

#### Enabling JWT token validation

1. By default, ASP.NET token validation is disabled to support local debugging.
2. Enable it by updating `appsettings.json`:
   ```json
   "TokenValidation": {
     "Enabled": true,
     "Audiences": [
       "{{ClientId}}" // This is the Client ID used for the Azure Bot
     ],
     "TenantId": "{{TenantId}}"
   },
   ```

### Developing the agent / Understanding the code

- See the [Agent Code Walkthrough](./Agent-Code-Walkthrough.md) for a detailed explanation of the code.

### Troubleshooting

#### Missing OpenAI key in appsettings.json

  - **Error when project is run through Visual Studio**

    When the project is run through Visual Studio, the following error occurs:
      ```
      System.ArgumentException: 'The value cannot be an empty string or composed entirely of whitespace. (Parameter 'endpoint')'
      ```
      The exception has call stack:
      ```
      >	System.Private.CoreLib.dll!System.ArgumentException.ThrowNullOrWhiteSpaceException(string argument, string paramName) Line 113	C#
        System.Private.CoreLib.dll!System.ArgumentException.ThrowIfNullOrWhiteSpace(string argument, string paramName) Line 98	C#
        Microsoft.SemanticKernel.Connectors.OpenAI.dll!Microsoft.SemanticKernel.Verify.NotNullOrWhiteSpace(string str, string paramName) Line 38	C#
        Microsoft.SemanticKernel.Connectors.AzureOpenAI.dll!Microsoft.SemanticKernel.AzureOpenAIServiceCollectionExtensions.AddAzureOpenAIChatCompletion(Microsoft.Extensions.DependencyInjection.IServiceCollection services, string deploymentName, string endpoint, string apiKey, string serviceId, string modelId, string apiVersion, System.Net.Http.HttpClient httpClient) Line 30	C#
        SemanticKernelSampleAgent.dll!Program.<Main>$(string[] args) Line 33	C#
      ```

  - **Error when project is run through command line**

    When the project is run through the the command line:
      ```bash
      dotnet run
      ```
      The following error occurs:
      ```
      C:\Agent365-Samples\dotnet\semantic-kernel\sample-agent\MyAgent.cs(145,48): warning CS8602: Dereference of a possibly null reference.
      Unhandled exception. System.ArgumentException: The value cannot be an empty string or composed entirely of whitespace. (Parameter 'endpoint')
        at System.ArgumentException.ThrowNullOrWhiteSpaceException(String argument, String paramName)
        at System.ArgumentException.ThrowIfNullOrWhiteSpace(String argument, String paramName)
        at Microsoft.SemanticKernel.AzureOpenAIServiceCollectionExtensions.AddAzureOpenAIChatCompletion(IServiceCollection services, String deploymentName, String endpoint, String apiKey, String serviceId, String modelId, String apiVersion, HttpClient httpClient)
        at Program.<Main>$(String[] args) in C:\Agent365-samples\dotnet\semantic-kernel\sample-agent\Program.cs:line 33
      ```

  - **Solution**

    Configure the OpenAI or Azure OpenAI settings in `appsettings.json` as described in the [Configuration](#configuration) section above.

## Further reading
To learn more about Agent 365, see [Agent 365](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/).
