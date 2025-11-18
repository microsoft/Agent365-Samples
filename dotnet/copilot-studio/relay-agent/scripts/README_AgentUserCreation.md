## Creating the Agent Identity & Agent User

This process will automatically create an Agent Identity (based on the Agent Blueprint Id) and the Agent User which is coming from the Agent Identity.

To create the Agent Identity & Agent User, run this script in PowerShell:

- `createAgenticUser.ps1` (interactive mode)
- `createAgenticUser.ps1 -ConfigFile "config.json"` (config mode)

You will need to provide:
- **Tenant ID**
- **Agent Blueprint ID** – this is the Application (client) ID of the agent blueprint from the previous step
- **Agent Blueprint Client Secret** – navigate to your agent blueprint > Certificates & secrets > Client secrets > New client secret to obtain this information, make sure you save this value if you want to reuse it
- **Agent Identity Display Name** – this will be the name of your Agent Identity application
- **Agent User Display Name** – this will be the name your new Agent User
- **Agent User Principal Name** – this is a unique email address of your user; it should have the domain name that exists in your tenant

Sample `config.json`:
```json
{
    "TenantId": "",
    "AgentBlueprintId": "",
    "AgentBlueprintClientSecret": "",
    "AgentIdentityDisplayName": "Hello World Identity",
    "AgentUserDisplayName": "Hello World User",
    "AgentUserPrincipalName": "helloworld-user@<your domain>"
}
```

## Granting Consent for the Agent Identity

Navigate to this URL to automatically give permissions to your Agent Identity (and Agent User) to access Graph, which is needed for the token exchange:

**Example for Graph scopes:**
```
https://login.microsoftonline.com/<TenantId>/v2.0/adminconsent?client_id=<AgentIdentityId>&scope=User.ReadBasic.All Mail.Send Mail.Read Chat.Read Chat.ReadWrite&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

**Note:** This is giving access to `User.ReadBasic.All Mail.Send Mail.Read Chat.Read Chat.ReadWrite`, you can expand the permissions if needed.
if it redirects after accepting using permissions and we see https://entra.microsoft.com/TokenAuthorize?admin_consent=True in the url, then its done. Permissions can be validated for the Agent Identity Id in the azure portal.

**Example for non-Graph scopes** (Connectivity.Connections.Read needed for MCP Tools):
```
https://login.microsoftonline.com/5369a35c-46a5-4677-8ff9-2e65587654e7/v2.0/adminconsent?client_id=416fa9f7-e69d-4e7b-8c8f-7b116634d34e&scope=0ddb742a-e7dc-4899-a31e-80e797ec7144/Connectivity.Connections.Read&redirect_uri=https://entra.microsoft.com/TokenAuthorize&state=xyz123
```

For non-Graph scopes note that you need to add the resourceId to the scope: `0ddb742a-e7dc-4899-a31e-80e797ec7144/Connectivity.Connections.Read` in the example above.

Once this is done, you should be able to see the permissions granted in the Azure portal for your agent application.

For MCP tools you need to get the resource id for Power Platform API (and Power Platform API - Test). To get these, search for these apps in your azure tenant, open the service principal and copy the application id. 

Alternatively, you can manage permissions by going to your Agent Identity in Azure portal and navigating to Security > Permissions.