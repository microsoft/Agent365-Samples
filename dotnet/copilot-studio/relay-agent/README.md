# Calling Copilto Studio Setup

This sample demonstrates how to call Copilot Studio Agents from an Agent instance.

## Run the setup scripts

Run the following scripts. You can find the scripts in the `scripts` folder.

### 1. Creating Delegated Consent for Agent Application Creation

**Script:** `DelegatedAgentApplicationCreateConsent.ps1`

Callers of this script (users in your tenant) are required to be **Global Admins** to create Agent Applications.

Also, for you to be able to create the Agent Blueprint, you need to grant the `AgentApplication.Create` permission to the **Microsoft Graph Command Line Tools** application. This script automates that step.

You will need to provide:

- **Tenant ID** – navigate to **Entra ID → Tenant properties** for this information  
- **Calling App ID** – use `14d82eec-204b-4c2f-b7e8-296a70dab67e` for *Microsoft Graph Command Line Tools*

Run from PowerShell:

```powershell
.\DelegatedAgentApplicationCreateConsent.ps1 `
  -TenantId "<your-tenant-id>" `
  -CallingAppId "14d82eec-204b-4c2f-b7e8-296a70dab67e"
```

### 2. Creating the Agent Blueprint

**Script:** `createAgentBlueprint.ps1`

This script:

1. Creates an Agent Blueprint application in your tenant.
1. Optionally links it to your App Service managed identity (MSI Principal ID).
1. Configures default scopes and Graph permissions.

You can run this script in two modes:

**Interactive mode:**

```powershell
.\createAgentBlueprint.ps1
```

You will be prompted for:

- **Tenant ID**
- **MSI Principal ID** – the Object (principal) ID of the managed identity for the App Service that you created (optional).
- **Display Name** – the display name for the Agent Blueprint application.

**Config mode (recommended for CI / repeatable setup):**

```powershell
.\createAgentBlueprint.ps1 -ConfigFile ".\config.json"
```

You will need a config.json file similar to:

```json
{
  "TenantId": "<your-tenant-id>",
  "MsiPrincipalId": "<managed-identity-object-id (optional)>",
  "AgentBlueprintDisplayName": "Kairo Agent Blueprint"
}
```

The script will:

1. Connect to the tenant
1. Create the Agent Blueprint app
1. Create the Service Principal
1. Configure default Graph scopes
1. (Optionally) create a federated credential for your managed identity

After the script runs, record the Agent Blueprint Application ID.

### 3. Adding Inheritable Permissions

**Script:** `Add-AgentBlueprintPermissions.ps1`

This script configures inheritable delegated scopes for your Agent Blueprint and admin-approves those scopes for the Blueprint service principal (via oauth2PermissionGrants).

**Prerequisites:**

Before running this script, you must:

- Have already run Script #1 and Script #2.
- Have the Microsoft Graph PowerShell SDK installed.

Connect with a token that includes the necessary permissions, for example:

```powershell
Connect-MgGraph -TenantId "<your-tenant-id>" `
  -Scopes @(
    "AgentIdentityBlueprint.ReadWrite.All",
    "Application.ReadWrite.All",
    "Policy.ReadWrite.PermissionGrant"
  )
```

You can verify the scopes with:

```powershell
(Get-MgContext).Scopes
```

### 4. Add CopilotStudio delegated scope for Power Platform API

This call adds the `CopilotStudio.Copilots.Invoke` delegated scope as an inheritable scope for the Agent Blueprint, and admin-approves that scope for the Blueprint service principal. This is necessary for your Agent Blueprint to be able to call Copilot Studio Agents.

**Resource:**

- **Resource App ID:** 8578e004-a5c6-46e7-913e-12f58912df43
- **Scope:** CopilotStudio.Copilots.Invoke

**Command:**

```powershell
.\Add-AgentBlueprintPermissions.ps1 `
  -TenantId "<your-tenant-id>" `
  -AgentBlueprintAppId "<your-agent-blueprint-app-id>" `
  -ResourceAppId "8578e004-a5c6-46e7-913e-12f58912df43" `
  -Scopes "CopilotStudio.Copilots.Invoke"
```

This will:

1. Upsert the inheritable permissions on the Agent Blueprint:
    - `inheritableScopes = microsoft.graph.enumeratedScopes`
    - `scopes = ["CopilotStudio.Copilots.Invoke"]`
2. Ensure there is a tenant-wide oauth2PermissionGrant for:
    - `clientId = <Blueprint SP Id>`
    - `resourceId = <Power Platform API SP Id>`
    - `scope` includes `CopilotStudio.Copilots.Invoke`

### 5. Enable all delegated scopes for the Messaging Bot API

For the Messaging Bot API, you want the Agent Blueprint to inherit all allowed delegated scopes from the resource.

**Resource:**

- **Resource App ID:** 5a807f24-c9de-44ee-a3a7-329e88a00ffc

**Command:**

```powershell
.\Add-AgentBlueprintPermissions.ps1 `
  -TenantId "<your-tenant-id>" `
  -AgentBlueprintAppId "<your-agent-blueprint-app-id>" `
  -ResourceAppId "5a807f24-c9de-44ee-a3a7-329e88a00ffc" `
  -AllAllowed
```

This will:

1. Configure inheritable permissions on the Agent Blueprint with:
    - `inheritableScopes = microsoft.graph.allAllowedScopes`
1. Read all delegated scopes (oauth2PermissionScopes) from the Messaging Bot API service principal.
1. Create or update a tenant-wide oauth2PermissionGrant so that the Blueprint service principal is admin-consented for all those delegated scopes.

### 6. Verifying the configuration

To verify the inheritable permissions for your Agent Blueprint:

```powershell
$bpAppId = "<your-agent-blueprint-app-id>"
$bpObj   = Get-MgApplication -Filter "appId eq '$bpAppId'"
$bpObjId = $bpObj.Id

Invoke-MgGraphRequest -Method GET `
  -Uri "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$bpObjId/inheritablePermissions" `
  -Headers @{ "OData-Version" = "4.0" } |
  ConvertTo-Json -Depth 10
```

You should see entries for:

- `resourceAppId = 8578e004-a5c6-46e7-913e-12f58912df43 with enumeratedScopes containing CopilotStudio.Copilots.Invoke`
- `resourceAppId = 5a807f24-c9de-44ee-a3a7-329e88a00ffc with allAllowedScopes`

To verify admin consent (optional):

```powershell
$bpSp      = Get-MgServicePrincipal -Filter "appId eq '$bpAppId'"
$bpSpId    = $bpSp.Id
$resource1 = Get-MgServicePrincipal -Filter "appId eq '8578e004-a5c6-46e7-913e-12f58912df43'"
$resource2 = Get-MgServicePrincipal -Filter "appId eq '5a807f24-c9de-44ee-a3a7-329e88a00ffc'"

$filter1 = "clientId eq '$bpSpId' and resourceId eq '$($resource1.Id)' and consentType eq 'AllPrincipals'"
$filter2 = "clientId eq '$bpSpId' and resourceId eq '$($resource2.Id)' and consentType eq 'AllPrincipals'"

Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=$([System.Uri]::EscapeDataString($filter1))"
Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=$([System.Uri]::EscapeDataString($filter2))"
```

### 7. Create a client secret (optional)

If your Agent Blueprint will not be using a managed identity, you need to create a client secret for it.

Run the following command:

```powershell
Invoke-MgGraphRequest -Method POST `
  -Uri "https://graph.microsoft.com/beta/applications/<AGENT_BLUEPRINT_OBJECT_ID>/addPassword" `
  -Body (@{
      passwordCredential = @{
          displayName = "My Secret"
          endDateTime = "2026-08-05T23:59:59Z"
      }
  } | ConvertTo-Json) `
  -Headers @{ "Content-Type" = "application/json" }
```

## Creating an Azure Bot Service Resource

After creating the Agent Blueprint and configuring inheritable delegated permissions, the next step is to provision an **Azure Bot Service** resource. This bot becomes the *service identity* through which your agent code will communicate.

> **Important:**  
> The **Bot’s App ID must be exactly the same as the Agent Blueprint App ID** created in Step #2.  
> This ensures the Bot Service and the Agent Blueprint share the same underlying identity and token configuration.

### 1. Open the Azure Portal

Navigate to:

**https://portal.azure.com**

#### 2. Create a New Resource

1. Select **Create a Resource** (top-left).
2. Search for **Azure Bot**.
3. Select **Azure Bot** from the marketplace.
4. Click **Create**.

### 3. Configure the Bot Basics

Fill in the following fields:

| Field | Value |
|-------|-------|
| **Subscription** | Your subscription |
| **Resource Group** | Choose an existing group or create a new one |
| **Bot handle** | A globally unique name (e.g., `my-agent-bot`) |
| **Type of App** | **Single-tenant** |
| **Microsoft App ID** | **Paste your Blueprint App ID** |
| **Type of App (App Registration)** | Select **Use existing app registration** |
| **Existing App Registration App ID** | **Same as above** |

> **❗ Critical requirement**:  
> The **Bot’s Microsoft App ID must be the Blueprint App ID** (`f5544c48-63d7-473c-887c-0a02ebbab2e7`) that was created earlier.

Do **NOT** create a new App Registration.  
Select **"Use existing"** and supply the Blueprint App ID.

### 5. Review + Create

1. Click **Review + Create**
2. Confirm your settings
3. Click **Create**

Deployment usually takes 20–45 seconds.

### 7. Connect to Teams

1. After deployment, navigate to your Bot resource.
1. Select **Channels** from the left menu.
1. Click on the **Microsoft Teams** icon.
1. Accept the Terms of Service.
1. Complete the setup.

## Connect notifications to your Bot

You now need to relay notifications from your Agent instance to your Bot Service.

1. Navigate to [[https://https://dev.teams.microsoft.com/tools/agent-blueprint](https://dev.teams.microsoft.com/tools/agent-blueprint)
1. Select your Agent Blueprint.
1. Navigate to **Configuration**
1. Select **Bot based** for **Agent type**
1. Paste in your Bot's **Microsoft App ID** which is the same as your Agent Blueprint App ID.
1. Select **Save**

## Creating the Microsoft Admin Center Manifest

After creating the Agent Blueprint, configuring permissions, and setting up the Azure Bot resource, you must package your agent and publish it to your organization via the **Microsoft Admin Center**.

Publishing requires **two JSON files**:

1. **App Manifest (manifest.json)**  
2. **Agentic User Template Manifest (agenticUserTemplateManifest.json)**

The two files work together:

- The **App Manifest** represents the bot/agent as an app installable in Microsoft 365.
- The **Agentic User Template Manifest** describes how the Agent Blueprint is used to create Agent Users, enabling the “digital worker” or “custom agent” pattern inside M365.

Your Agent Blueprint App ID will be used in both files to bind everything to the same identity.

---

### 1. Create the Teams App Manifest (manifest.json)

Create a file named **manifest.json** in your app folder.

Replace:

- `{{APP_ID}}` with your **Agent Blueprint App ID**
- App name, description, icons, and developer information as you see fit

manifest.json:

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/vDevPreview/MicrosoftTeams.schema.json",
  "manifestVersion": "devPreview",
  "version": "1.0.0",
  "id": "{{APP_ID}}",
  "developer": {
    "name": "Your Team",
    "websiteUrl": "https://contoso.com",
    "privacyUrl": "https://contoso.com/privacy",
    "termsOfUseUrl": "https://contoso.com/terms"
  },
  "name": {
    "short": "Your Agent Name",
    "full": "Your Agent Full Name"
  },
  "description": {
    "short": "Short description of what your agent does.",
    "full": "A longer description of your agent, its capabilities, and intended use."
  },
  "icons": {
    "color": "color-icon.png",
    "outline": "outline-icon.png"
  },
  "accentColor": "#4464ee",
  "validDomains": [],
  "webApplicationInfo": {
    "id": "{{APP_ID}}",
    "resource": "api://{{APP_ID}}"
  },
  "bots": [
    {
      "botId": "{{APP_ID}}",
      "scopes": [
        "personal",
        "team",
        "groupChat",
        "copilot"
      ],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "copilotAgents": {
    "customEngineAgents": [
      {
        "id": "{{APP_ID}}",
        "type": "bot",
        "disclaimer": {
          "text": "This agent uses AI. Please verify important information."
        },
        "functionsAs": "agenticUserOnly",
        "agenticUserTemplateId": "digitalWorkerTemplate"
      }
    ]
  },
  "agenticUserTemplates": [
    {
      "id": "digitalWorkerTemplate",
      "file": "agenticUserTemplateManifest.json"
    }
  ]
}
```


### 2. Create the Agentic User Template Manifest

Create a second file named **agenticUserTemplateManifest.json**.

Replace:

- `{{APP_ID}}` with your **Agent Blueprint App ID**

agenticUserTemplateManifest.json:

```json
{
  "schemaVersion": "0.1.0-preview",
  "id": "digitalWorkerTemplate",
  "agentIdentityBlueprintId": "{{APP_ID}}",
  "communicationProtocol": "activityProtocol"
}
```

This file defines how Microsoft 365 should create **Agent Users** from your Agent Blueprint when users interact with your app.

### 3. Package the App

Create a ZIP file that contains:

- `manifest.json`
- `agenticUserTemplateManifest.json`
- `color-icon.png` (192×192)
- `outline-icon.png` (32×32)

Example:

my-agent-app.zip  
├── manifest.json  
├── agenticUserTemplateManifest.json  
├── color-icon.png  
└── outline-icon.png  

---

### 4. Upload to Microsoft Admin Center

1. Visit:  
   **https://admin.microsoft.com/Adminportal/Home#/TeamsApps/ManageApps**

2. Select **Agents** → **All Agents** → **Upload custom agent**

3. Choose your ZIP file (`my-agent-app.zip`)

4. Complete the remaining steps

---

### 6. Activate the agent

After uploading, you can activate the agent for your organization.

1. Search for your agent by name
1. Select it
1. Click **Activate**
1. Complete the activation steps

## Instantiate the agent

You can now instantiate the agent. Eventually, you'll be able to do this via the Teams UI, but for now, you can use the `createAgentUser.ps1` script located in the `scripts` folder.

### 1. Create the Agent User

Follow the steps in [README_AgentUserCreation.md](./scripts/README_AgentUserCreation.md) to create an Agent User for your Agent Blueprint. You may need the client secret created earlier (see step 7 of "Creating the Agent Blueprint").

### 2. Assign Licenses

1. Open Entra and search for the Agent User you created under **Users**.
1. Copy the **Object ID** of the Agent User.
1. Go to the `https://admin.cloud.microsoft/#/users/:/UserDetails/<Object_ID>/LicensesAndApps` page (replace `<Object_ID>` with the actual Object ID).
1. Assign the agent with licenses to use Teams, Outlook, Microsoft 365, and Copilot Studio

### 3. Approve scopes
After creating the Agent User, you need to approve the delegated scopes for the Agent Identity so that the Agent User can access the necessary resources. To do so, navigate to these URLs in your browser (replace `<TenantId>` and `<AgentIdentityId>` with your actual Tenant ID and Agent Identity Application ID):

- https://login.microsoftonline.com/<TenantId>/v2.0/adminconsent?client_id=<AgentIdentityId>&scope=User.ReadBasic.All Mail.Send Mail.Read Chat.Read Chat.ReadWrite 8578e004-a5c6-46e7-913e-12f58912df43/CopilotStudio.Copilots.Invoke 0ddb742a-e7dc-4899-a31e-80e797ec7144/CopilotStudio.Copilots.Invoke&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123

## Create an agent in Copilot Studio

You now need to create an agent that will orchestrate the use of various MCP tools.

### 1. Create the Agent

1. Navigate to [https://copilotstudio.microsoft.com/](https://copilotstudio.microsoft.com/)
1. Select **Agents** → **New agent**
1. Setup your agent as you normally would
1. Go to **Tools**
1. Search for and add the following tools:
   1. **Microsoft Word MCP** – this allows the agent to create and reference Word documents
   1. **Microsoft SharePoint and OneDrive MCP** – this allows the agent to access and share files from SharePoint and OneDrive
   1. **Microsoft 365 User Profile MCP** – this allows the agent to look up user profile information

### 2. Publish the Agent

1. After configuring the agent, select **Publish**
1. Select **Force new version**
1. Select **Publish**
1. Wait for the agent to be published
1. Navigate to **Channels**
1. Select **Native app**
1. Copy the **Connection string** – you will need this in the next step

### 3. Share the agent

1. Select **...** in the top right corner of the agent authoring page
1. Select **Share agent**
1. Share the agent with the agent user you created earlier

## Build and Run the Sample

Congrats! You have finished the setup. We can now build and run the sample.

### 1. Running the sample project

1. Open appsettings.json in the sample project
1. Update the following settings:
    1. `ClientId` – your Agent Blueprint App ID
    1. `TenantId` – your Tenant ID
    1. `ConnectionUrl` – the connection string you copied from Copilot Studio
    1. `ClientSecret` – the client secret you created for your Agent Blueprint (if not using managed identity)
1. Save the file
1. Build and run the project by running the following commands from the terminal:

    ```bash
    dotnet build
    dotnet run
    ```

### 2. Tunneling to your agent from Azure Bot Service

1. Run `dev tunnels`. Please follow [Create and host a dev tunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started?tabs=windows) and host the tunnel with anonymous user access command as shown below:

  ```bash
  devtunnel host -p 3978 --allow-anonymous
  ```

1. Go back to your Azure Bot Service, select **Settings**, then **Configuration**, and update the **Messaging endpoint** to `{tunnel-url}/api/messages`

## Test the agent

You can now test the agent with the following scenarios:

1. Start a chat in Microsoft Teams
1. Send an email to the Agent User you created earlier
1. @-mention the agent in a Microsoft Word comment

## Troubleshooting

### My agent isn't showing up in Teams or Outlook

Ensure that an agent user has been created for your Agent Blueprint and that the Agent User has the necessary licenses assigned (Teams, Outlook, Microsoft 365, Copilot Studio). Without a license to Teams or Outlook, the agent will not appear in those applications.

### My agent is not responding

Ensure that your bot service is running and reachable from the internet. You can use the [Agent Playground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project?tabs=windows) to test connectivity to your bot service.

Also note that the response time for Word, Excel, and PowerPoint comment notification can take several minutes depending on system load.