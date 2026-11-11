# Agent Setup Guide — App Registration Approach

This document captures every step required to deploy a Custom Engine Agent using manual Azure AD app registration, Docker on Azure App Service, and the Microsoft Agent 365 SDK.

## Table of Contents

1. [Azure AD App Registration](#1-azure-ad-app-registration)
2. [Azure Bot Resource](#2-azure-bot-resource)
3. [Azure Container Registry & Docker](#3-azure-container-registry--docker)
4. [Azure App Service (Linux Container)](#4-azure-app-service-linux-container)
5. [Application Configuration](#5-application-configuration)
6. [Teams App Manifest & Sideloading](#6-teams-app-manifest--sideloading)
7. [Common Issues & Fixes](#7-common-issues--fixes)
8. [Verification Checklist](#8-verification-checklist)

---

## 1. Azure AD App Registration

### 1.1 Create the App Registration

```bash
az ad app create \
  --display-name "<your-bot-name>" \
  --sign-in-audience AzureADMyOrg
```

Record the `appId` (client ID) from the output.

### 1.2 Create a Client Secret

```bash
az ad app credential reset \
  --id <appId> \
  --display-name "BotSecret" \
  --years 2
```

Save the `password` — this is your `ClientSecret`.

### 1.3 Set the Application ID URI

```bash
az ad app update --id <appId> \
  --identifier-uris "api://botid-<appId>"
```

### 1.4 Expose an API Scope (`access_as_user`)

```bash
# Get the object ID
OBJECT_ID=$(az ad app show --id <appId> --query id -o tsv)

# Add the oauth2PermissionScopes via Graph API
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers "Content-Type=application/json" \
  --body '{
    "api": {
      "oauth2PermissionScopes": [{
        "adminConsentDescription": "Access as user",
        "adminConsentDisplayName": "Access as user",
        "id": "<generate-a-new-guid>",
        "isEnabled": true,
        "type": "User",
        "userConsentDescription": "Access as user",
        "userConsentDisplayName": "Access as user",
        "value": "access_as_user"
      }]
    }
  }'
```

### 1.5 Pre-authorize Teams Client IDs

Teams needs to be pre-authorized to obtain tokens silently for SSO. Add both Teams client IDs:

- **Teams Web**: `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`
- **Teams Desktop/Mobile**: `1fec8e78-bce4-4aaf-ab1b-5451cc387264`

```bash
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers "Content-Type=application/json" \
  --body '{
    "api": {
      "preAuthorizedApplications": [
        {
          "appId": "5e3ce6c0-2b1f-4285-8d4b-75ee78787346",
          "delegatedPermissionIds": ["<scope-id-from-step-1.4>"]
        },
        {
          "appId": "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
          "delegatedPermissionIds": ["<scope-id-from-step-1.4>"]
        }
      ]
    }
  }'
```

### 1.6 Configure Redirect URIs & Implicit Grant

```bash
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers "Content-Type=application/json" \
  --body '{
    "web": {
      "redirectUris": [
        "https://token.botframework.com/.auth/web/redirect"
      ],
      "implicitGrantSettings": {
        "enableAccessTokenIssuance": true,
        "enableIdTokenIssuance": true
      }
    }
  }'
```

### 1.7 Set Sign-In Audience

Must be `AzureADMyOrg` (SingleTenant):

```bash
az ad app update --id <appId> --sign-in-audience AzureADMyOrg
```

### 1.8 Add API Permissions

**Required Graph permissions** (delegated):
- `User.Read`, `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Mail.Send.Shared`
- `Directory.Read.All`, `Directory.ReadWrite.All`
- `Application.Read.All`, `Application.ReadWrite.All`
- `AgentIdentityBlueprint.ReadWrite.All`, `AgentIdentityBlueprint.UpdateAuthProperties.All`
- `AgentIdentityBlueprintPrincipal.Create`, `AgentIdentityBlueprintPrincipal.ReadWrite.All`

**Required Agent 365 Tools permissions** (resource: `ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`):
- `McpServersMetadata.Read.All`, `AgentTools.ListMCPServers.All`, `McpServers.Mail.All`
- Plus all other `McpServers.*` and `AgentTools.*` scopes — see working agent for full list.

### 1.9 Create a Service Principal

```bash
az ad sp create --id <appId>
```

---

## 2. Azure Bot Resource

### 2.1 Create the Bot

```bash
az bot create \
  --resource-group <rg-name> \
  --name <bot-name> \
  --app-type SingleTenant \
  --appid <appId> \
  --tenant-id <tenantId> \
  --endpoint "https://<webapp-name>.azurewebsites.net/api/messages" \
  --sku F0
```

### 2.2 Enable the Teams Channel

```bash
az bot msteams create --name <bot-name> --resource-group <rg-name>
```

### 2.3 Create the OAuth Connection (`GraphOBoConnection`)

```bash
az bot authsetting create \
  --resource-group <rg-name> \
  --name <bot-name> \
  --setting-name "GraphOBoConnection" \
  --provider-scope-string "User.Read" \
  --client-id <appId> \
  --client-secret "<client-secret>" \
  --service "Aadv2" \
  --parameters \
    clientId=<appId> \
    clientSecret=<client-secret> \
    tenantID=<tenantId> \
    scopes=User.Read \
    tokenExchangeUrl=api://botid-<appId>
```

> **Critical**: The `--provider-scope-string` and `scopes` parameter must be `User.Read` (NOT `api://botid-.../access_as_user`). The `tokenExchangeUrl` must match the app's `identifierUris`.

---

## 3. Azure Container Registry & Docker

### 3.1 Build the Docker Image

```bash
cd sample-agent
docker build -t <acr-name>.azurecr.io/<image-name>:<tag> .
```

### 3.2 Push to ACR

```bash
az acr login --name <acr-name>
docker push <acr-name>.azurecr.io/<image-name>:<tag>
```

---

## 4. Azure App Service (Linux Container)

### 4.1 Create the Web App

```bash
az webapp create \
  --resource-group <rg-name> \
  --name <webapp-name> \
  --plan <app-service-plan> \
  --container-image-name "<acr-name>.azurecr.io/<image-name>:<tag>" \
  --container-registry-url "https://<acr-name>.azurecr.io" \
  --container-registry-user <acr-username> \
  --container-registry-password <acr-password>
```

### 4.2 Configure App Settings

```bash
az webapp config appsettings set --name <webapp-name> --resource-group <rg-name> --settings \
  ASPNETCORE_ENVIRONMENT=Production \
  WEBSITES_PORT=8080 \
  Connections__ServiceConnection__Settings__ClientSecret="<client-secret>" \
  AIServices__AzureOpenAI__ApiKey="<aoai-api-key>"
```

### 4.3 Enable Always On

```bash
az webapp config set --name <webapp-name> --resource-group <rg-name> --always-on true
```

### 4.4 Enable Application Logging

```bash
az webapp log config --name <webapp-name> --resource-group <rg-name> \
  --docker-container-logging filesystem
```

---

## 5. Application Configuration

### 5.1 `appsettings.json`

All secrets should use placeholders in source and be overridden via App Settings or environment variables:

```json
{
  "Connections": {
    "ServiceConnection": {
      "Settings": {
        "AuthType": "ClientSecret",
        "ClientId": "<YOUR-APP-ID>",
        "ClientSecret": "<YOUR-CLIENT-SECRET>",
        "AuthorityEndpoint": "https://login.microsoftonline.com/<YOUR-TENANT-ID>",
        "TenantId": "<YOUR-TENANT-ID>",
        "Scopes": ["https://api.botframework.com/.default"]
      }
    }
  },
  "TokenValidation": {
    "Enabled": false,
    "Audiences": ["<YOUR-APP-ID>"],
    "TenantId": "<YOUR-TENANT-ID>"
  },
  "AIServices": {
    "AzureOpenAI": {
      "DeploymentName": "gpt-4.1",
      "Endpoint": "<YOUR-AOAI-ENDPOINT>",
      "ApiKey": "<YOUR-AOAI-API-KEY>"
    }
  },
  "OpenWeatherApiKey": "<YOUR-OPENWEATHER-API-KEY>"
}
```

### 5.2 Port Configuration

The Dockerfile exposes port `8080`. The app binds to `http://+:8080` via `ASPNETCORE_URLS`.
The Azure App Service `WEBSITES_PORT` must also be `8080`.

The `Program.cs` only binds to `localhost:3978` in Development mode — **in Production, it uses the default `ASPNETCORE_URLS`**.

---

## 6. Teams App Manifest & Sideloading

### 6.1 `appPackage/manifest.json`

All ID fields must use the same `<appId>`:

```json
{
  "id": "<YOUR-APP-ID>",
  "copilotAgents": {
    "customEngineAgents": [{ "id": "<YOUR-APP-ID>", "type": "bot" }]
  },
  "bots": [{ "botId": "<YOUR-APP-ID>", "scopes": ["personal"] }],
  "validDomains": [
    "token.botframework.com",
    "<YOUR-WEBAPP-NAME>.azurewebsites.net"
  ],
  "webApplicationInfo": {
    "id": "<YOUR-APP-ID>",
    "resource": "api://botid-<YOUR-APP-ID>"
  }
}
```

### 6.2 Create the Sideload Package

```powershell
Compress-Archive -Path appPackage\manifest.json, appPackage\color.png, appPackage\outline.png `
  -DestinationPath appPackage\agent-app.zip
```

### 6.3 Sideload to Teams

1. Open **Teams → Apps → Manage your apps → Upload a custom app**
2. Select the `.zip` file
3. Open the installed app and send a message

### 6.4 Updating the App

When re-sideloading after changes:
1. **Bump the `version`** in `manifest.json` (e.g., `1.0.3` → `1.0.4`)
2. Remove the old app from Teams (**Apps → Manage your apps → Remove**)
3. Delete any stale chat conversations with the bot
4. Upload the new ZIP

---

## 7. Common Issues & Fixes

### 7.1 `async void` Bug in `AgentMetrics.InvokeObservedHttpOperation`

**Symptom**: Container crashes with `ObjectDisposedException` (exit code 139). DirectLine may partially work.

**Cause**: The method signature takes `Action func` but is called with `async () => { await ... }`, creating an async void fire-and-forget. The HTTP response stream is disposed before the adapter finishes.

**Fix**: Change the method signature:

```csharp
// Before (broken):
public static Task InvokeObservedHttpOperation(string operationName, Action func)

// After (fixed):
public static async Task InvokeObservedHttpOperation(string operationName, Func<Task> func)
```

And `await func()` instead of `func()`.

### 7.2 Port Mismatch (`localhost:3978` vs `8080`)

**Symptom**: Container starts but returns 502/timeout.

**Cause**: `ASPNETCORE_ENVIRONMENT=Development` causes `Program.cs` to bind only to `localhost:3978`, which doesn't match `WEBSITES_PORT=8080`.

**Fix**: Set `ASPNETCORE_ENVIRONMENT=Production` in App Settings.

### 7.3 OAuth Scopes Self-Referential

**Symptom**: Sign-in fails; SSO token exchange doesn't work.

**Cause**: OAuth connection `scopes` set to `api://botid-.../access_as_user` instead of `User.Read`.

**Fix**: Delete and recreate the `GraphOBoConnection` with `scopes=User.Read`.

### 7.4 Missing Redirect URIs

**Symptom**: OAuth sign-in popup fails with redirect error.

**Fix**: Add `https://token.botframework.com/.auth/web/redirect` to the app registration's redirect URIs.

### 7.5 Implicit Grant Disabled

**Symptom**: Token exchange returns empty tokens.

**Fix**: Enable both `enableAccessTokenIssuance` and `enableIdTokenIssuance` in the app registration's `web.implicitGrantSettings`.

### 7.6 `signInAudience` Mismatch

**Symptom**: Authentication fails with audience validation errors.

**Cause**: Bot is `SingleTenant` but app registration is `AzureADMultipleOrgs`.

**Fix**: `az ad app update --id <appId> --sign-in-audience AzureADMyOrg`

### 7.7 Missing API Permissions

**Symptom**: MCP tools fail to load; agent responds with basic weather/datetime only.

**Fix**: Copy the full `requiredResourceAccess` from a working agent and grant admin consent. See Section 1.8.

### 7.8 Teams "Not Found" Error

**Symptom**: Clicking the bot in Teams shows "Not found" — messages never reach the backend.

**Cause**: The MsTeams channel registration is in a corrupted state from prior configuration changes.

**Fix**: Delete and recreate the Teams channel:

```bash
az bot msteams delete --name <bot-name> --resource-group <rg-name>
az bot msteams create --name <bot-name> --resource-group <rg-name>
```

Then remove the app from Teams and re-sideload with a bumped manifest version.

### 7.9 Wrong App Setting Name

**Symptom**: Auth fails despite correct credentials.

**Cause**: Using `BotServiceConnection` instead of the correct `ServiceConnection` name.

**Fix**: Ensure the connection name in `appsettings.json` matches what's referenced in `ConnectionsMap`.

---

## 8. Verification Checklist

Run these checks before declaring the agent ready:

| # | Check | Command / Action |
|---|---|---|
| 1 | App registration exists | `az ad app show --id <appId>` |
| 2 | `signInAudience` = `AzureADMyOrg` | `az ad app show --id <appId> --query signInAudience` |
| 3 | `identifierUris` = `api://botid-<appId>` | `az ad app show --id <appId> --query identifierUris` |
| 4 | `access_as_user` scope exposed | `az ad app show --id <appId> --query api.oauth2PermissionScopes` |
| 5 | Teams clients pre-authorized | `az ad app show --id <appId> --query api.preAuthorizedApplications` |
| 6 | Redirect URI set | `az ad app show --id <appId> --query web.redirectUris` |
| 7 | Implicit grant enabled | `az ad app show --id <appId> --query web.implicitGrantSettings` |
| 8 | Service principal exists | `az ad sp show --id <appId>` |
| 9 | API permissions granted | `az ad app permission admin-consent --id <appId>` |
| 10 | Bot endpoint correct | `az bot show --name <bot> --rg <rg> --query properties.endpoint` |
| 11 | Teams channel enabled | `az bot msteams show --name <bot> --rg <rg>` |
| 12 | OAuth connection configured | `az bot authsetting show --name <bot> --rg <rg> -c GraphOBoConnection` |
| 13 | Container listens on 8080 | Check logs: `Now listening on: http://[::]:8080` |
| 14 | `ASPNETCORE_ENVIRONMENT=Production` | `az webapp config appsettings list ...` |
| 15 | Health endpoint responds | `curl https://<webapp>.azurewebsites.net/api/health` |
| 16 | DirectLine test passes | Start conversation, send message, receive OAuthCard |
| 17 | Teams sideload works | Upload ZIP, open chat, receive sign-in prompt or response |
