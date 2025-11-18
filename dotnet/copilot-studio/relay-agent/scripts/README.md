# Kairo Setup Scripts

This directory contains scripts to help you set up Agent Blueprint, Agent Identities, and Agent Users for the Kairo platform.

## Creating the Agent Blueprint

### Prerequisite – Script #1

Callers of this script (users in your tenant) are required to be **Global Admins** to create Agent Applications.

Also, for you to be able to create the Agent Blueprint, you need to grant the `AgentApplication.Create` permission to the Microsoft Graph Command Line Tools application. For that, you can execute this script in PowerShell. Copied from [here](https://learn.microsoft.com/en-us/graph/permissions-reference#agentapplication-permissions):

- `DelegatedAgentApplicationCreateConsent.ps1`

You will need to provide:
- **Tenant ID** – navigate to "Tenant properties" for this information
- **Calling App ID** – use `14d82eec-204b-4c2f-b7e8-296a70dab67e` for Microsoft Graph Command Line Tools

### Creating the Agent Blueprint – Script #2

To create the Agent Blueprint and link it to your App Service, run this script in PowerShell:

- `createAgentBlueprint.ps1` (interactive mode)
- `createAgentBlueprint.ps1 -ConfigFile "config.json"` (config mode)

You will need to provide:
- **Tenant ID**
- **MSI Principal ID** – this is your Object (principal) ID of the managed identity for the App Service that you created

Sample `config.json`, replace with appropriate values:
```json
{
    "TenantId": "",
    "MsiPrincipalId": ""
}
```

## Granting Consent for the Agent Blueprint and Enabling Inheritance

We can grant consent at Agent Blueprint level and choose which of these permissions should be passed down to the agent identities being created from this blueprint.

### Assign Necessary Permissions to Agent Blueprint

Navigate to this URL to automatically give permissions to your Agent Blueprint to necessary scopes needed by your agent and for token authorization:

```
https://login.microsoftonline.com/{TenantId}/v2.0/adminconsent?client_id={AgentApplicationIdentity}&scope={Scopes}&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

**Example for Graph scopes:**
```
https://login.microsoftonline.com/5369a35c-46a5-4677-8ff9-2e65587654e7/v2.0/adminconsent?client_id=a9c3e0c7-b2ce-46db-adf7-d60120faa0cd&scope=Mail.ReadWrite Mail.Send Chat.ReadWrite&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

**Example for non-Graph scopes** (Connectivity.Connections.Read needed for MCP Tools):
```
https://login.microsoftonline.com/5369a35c-46a5-4677-8ff9-2e65587654e7/v2.0/adminconsent?client_id=416fa9f7-e69d-4e7b-8c8f-7b116634d34e&scope=0ddb742a-e7dc-4899-a31e-80e797ec7144/Connectivity.Connections.Read&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

For non-Graph scopes note that you need to add the resourceId to the scope: `0ddb742a-e7dc-4899-a31e-80e797ec7144/Connectivity.Connections.Read` in the example above.

Once this is done, you should be able to see the permissions granted in the Azure portal for your agent blueprint.

### Enable Consent Permission Inheritance for the Agent Blueprint

Once the inheritance is set, all Agent Identities that are created get the same consents defined in the inheritance allowed list no matter when the AAI created (i.e., before or after the inheritance call is done).

```http
POST https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/{ObjectId of AA}/inheritablePermissions

Content-Type: application/json
{
  "resourceAppId": "ResourceId of the app that we are giving the consent. e.g, Graph Resource ID"
  "inheritableScopes": {
    "@odata.type": "microsoft.graph.enumeratedScopes",
    "scopes": [
          // ... list of scope .. //
    ]
  }
}
```

**Example:**
```http
POST https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/45f01fc6-c60e-4458-ac36-731d2ddb090f/inheritablePermissions

Content-Type: application/json
{
  "resourceAppId": "00000003-0000-0000-c000-000000000000",
  "inheritableScopes": {
    "@odata.type": "microsoft.graph.enumeratedScopes",
    "scopes": [
      "Mail.Read",
      "Mail.Send", 
      "Mail.ReadWrite",
      "Chat.ReadWrite",
      "User.ReadBasic.All"
    ]
  }
}
```

Refer to [Agent User README](README_AgentUserCreation.md) for next steps on creation agent identity, user and granting permissions at identity level.

