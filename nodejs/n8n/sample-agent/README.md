# n8n Sample Agent

This sample demonstrates how to build an agent using n8n with its Microsoft Agent 365 node. The new Microsoft Agent 365 node in n8n has built-in:

- **Observability**: End-to-end tracing, caching, and monitoring for the agent
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions

## Prerequisites

- Microsoft Agent 365
- n8n instance (version 2.7.0 or later) with Microsoft Agent 365 Node

## Running the Agent

This sample is fully contained within n8n. The **Microsoft Agent 365** node encapsulates all necessary code and integrations for the agent to function. There is no external code to run or compile; simply use your n8n workflow and connect it to Agent Identity as explained below.
 
## Deploying the agent

This guide will walk you through creating an Agent 365 using n8n's Microsoft Agent 365 node.

### Overview

1. **Create Agent Blueprint** - Register your agent identity in Microsoft Teams Developer Portal
2. **Publish to Microsoft Admin Center** - Make your agent available for administration (skip deployment step)
3. **Add Client Secret** - Configure authentication credentials in Azure Portal
4. **Create n8n Workflow** - Build your agent logic using the Microsoft Agent 365 node
5. **Configure Backend URL** - Connect your agent blueprint to the n8n webhook

### Detailed Setup

#### Step 1: Create Agent Blueprint

Create your agent identity in the Microsoft Teams Developer Portal:
- Follow the [Agent Identity Blueprint guide](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/manage-your-apps-in-developer-portal#agent-identity-blueprint)


#### Step 2: Publish to Microsoft Admin Center

Publish your agent for administrative management:
1. Download the manifest directory from the sample agent
2. Edit the manifest.json file (at minimum, give it a custom id and tweak the agenticUserTemplates.id value)
3. Edit the agenticUserTemplateManifest.json so that it matches the agenticUserTemplates.id you set in step 2.
4. Compress all files inside the manifest directory into a manifest.zip file (make sure you're not compressing the folder, but just the individual files)
5. Go to MAC > Agents > All agents > Upload custom agent and upload the zip file and complete the wizard.

#### Step 3: Add Client Secret

Configure authentication credentials:
- Navigate to your app registration in the Azure Portal
- Follow the [credentials guide](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials?tabs=client-secret) to add a client secret
- Copy the **Client Secret** value (you'll only see this once)

OR

Follow the [documentation](https://learn.microsoft.com/en-us/graph/api/agentidentityblueprint-addpassword?view=graph-rest-beta) to add and see the client secret. You can also run the following powershell script, replacing your TenantID with your tenant's id and the applicationID with your blueprint id.

```powershell
Connect-MgGraph -Scopes "AgentIdentityBlueprint.AddRemoveCreds.All" -TenantId <TenantID>

$applicationId = "<application-id>"

# Define the secret properties
$displayName = "My Client Secret"


# Construct the password credential
$passwordCredential = @{
    displayName = $displayName
}

# Add the password (client secret)
$response = Add-MgApplicationPassword -ApplicationId $applicationId -PasswordCredential $passwordCredential

# Output the generated secret (only returned once!)
Write-Host "Secret Text: $($response.secretText)"
```

#### Step 4: Grant Permissions for Agent

Grant your Agent Blueprint access to Microsoft 365 by following the [agent access guide](https://learn.microsoft.com/en-us/entra/agent-id/identity-professional/grant-agent-access-microsoft-365). You must also [enable inheritable permissions](https://learn.microsoft.com/en-us/entra/agent-id/identity-professional/configure-inheritable-permissions-blueprints) to allow the agent to act on behalf of users.

Consent for the required scopes can be given as shown below, just replace your tenant id, and blueprint id in the specified places:

- Graph Scope:

```
https://login.microsoftonline.com/<tenant-id>/v2.0/adminconsent?client_id=<blueprint-id>&scope=User.ReadBasic.All Mail.Send Mail.Read Chat.Read Chat.ReadWrite&redirect_uri= https://entra.microsoft.com/TokenAuthorize&state=xyz123
```


- Agent 365 Tools Scope:

```
https://login.microsoftonline.com/<tenant-id>/v2.0/adminconsent?client_id=<blueprint-id>&scope=ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Calendar.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Excel.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Files.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Mail.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Me.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.OneDriveSharepoint.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.PowerPoint.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.SharepointLists.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Teams.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServers.Word.All ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/McpServersMetadata.Read.All&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

- Power Platform API

```
https://login.microsoftonline.com/<tenant>/v2.0/adminconsent?client_id=<blueprint-id>&scope=8578e004-a5c6-46e7-913e-12f58912df43/Connectivity.Connections.Read&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

**Note**: If for any reason Power Platform API SP is not provisioned in your tenant, you can simply add it to your tenant with the API call below:

```
POST - https://graph.microsoft.com/v1.0/servicePrincipals

{ 
  "appId": "8578e004-a5c6-46e7-913e-12f58912df43" 
}
```

- APX/Messaging Bot API Application Scope

You can grant consent to the Messaging Bot API service principal by calling this via graph explorer:

```
POST - https://graph.microsoft.com/v1.0/oauth2PermissionGrants
{
  "clientId": "<blueprint-id>",
  "consentType": "AllPrincipals",
  "resourceId": "a6c6ce43-d3ed-40ae-a6d2-4f9c028e0355",
  "scope": "user_impersonation Authorization.ReadWrite"
}

a6c6ce43-d3ed-40ae-a6d2-4f9c028e0355 -- Object ID of the SP for Messaging Bot API Application
```


#### Step 5: Create n8n Workflow

Build your agent logic in n8n:
- Create a new workflow in your n8n instance
- Add the Microsoft Agent 365 node to your workflow
- Configure the node with your credentials:
  - **Blueprint ID** (from Step 1)
  - **Tenant ID** (from Step 1)
  - **Client Secret** (from Step 3)
- Design your agent's conversation logic and tool integrations
- **Copy the webhook URL** from the trigger node - you'll need this for the final step

For n8n workflow creation guidance, see the [n8n documentation](https://docs.n8n.io/).

#### Step 6: Configure Backend URL

Connect your agent blueprint to the n8n workflow:
- Return to the [Microsoft Teams Developer Portal](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/manage-your-apps-in-developer-portal#configure-the-agent-identity-blueprint)
- Navigate to your Agent Blueprint → **Configuration**
- Select **API Based** as the configuration type
- Set the **Backend URL** to your n8n workflow's webhook URL from Step 5

#### Step 7: Hire an agent as a digital worker
- Follow the [documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/onboard) to hire an agent as a digital worker

Your agent is now ready to handle conversations through Microsoft 365!


## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/)
- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [n8n documentation](https://docs.n8n.io/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
