# Agent 365 Custom Engine Agent — Blueprint + Identity Auth Setup Guide

This guide documents the complete setup for running an Agent 365 Custom Engine Agent using the **Blueprint + Identity** authentication model (as opposed to the traditional App Registration model).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Azure Resource Creation](#3-azure-resource-creation)
4. [Permissions & Role Assignments](#4-permissions--role-assignments)
5. [Code Changes from Base Sample](#5-code-changes-from-base-sample)
6. [Configuration (appsettings.json)](#6-configuration-appsettingsjson)
7. [Teams App Manifest](#7-teams-app-manifest)
8. [Build & Deploy](#8-build--deploy)
9. [Authentication Flow Deep-Dive](#9-authentication-flow-deep-dive)
10. [SDK Auth Limitations for Blueprint + Identity](#10-sdk-auth-limitations-for-blueprint--identity)
11. [Known Limitations](#11-known-limitations)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Architecture Overview

In the Blueprint + Identity model, Microsoft Entra creates two **platform-managed** objects instead of traditional App Registrations:

| Entity | Type | Purpose |
|--------|------|---------|
| **Identity App** | `@odata.type: agentIdentity` / `ServiceIdentity` | The bot's `msaAppId` — the principal identity for the agent |
| **Blueprint App** | `@odata.type: agentIdentityBlueprint` | A "credential broker" that can acquire tokens on behalf of the Identity App |

Neither is a standard Azure AD App Registration. You cannot create client secrets or certificates on the Identity App directly. Instead, authentication flows through a **3-hop token chain**:

```
Managed Identity ──(FIC)──► Blueprint App ──(FMI Path)──► Identity App ──(Client Assertion)──► Resource
```

### Why This Matters

- Standard SDK `AuthType` values (`ClientSecret`, `Certificate`, `UserManagedIdentity`, etc.) don't work because the Identity App isn't a real App Registration
- A custom `IAccessTokenProvider` (`BlueprintFmiTokenProvider`) is required to implement the 3-hop token chain
- User token acquisition (SSO, OAuth card) is not possible because Bot Framework Token Service requires a real App Registration as the bot's `msaAppId`

---

## 2. Prerequisites

- Azure subscription with Contributor access
- Azure CLI (`az`) installed and logged in
- .NET 8.0 SDK
- Microsoft Agents SDK `1.5.x-beta` or later (uses MSAL with `WithFmiPath` support)
- Access to create resources in Microsoft Entra ID (Azure AD)

---

## 3. Azure Resource Creation

### 3.1 User-Assigned Managed Identity

```bash
az identity create \
  --name <your-mi-name> \
  --resource-group <your-resource-group> \
  --location westus
```

**Output values needed:**
| Property | Value |
|----------|-------|
| `clientId` | `<your-mi-client-id>` |
| `principalId` | `<your-mi-principal-id>` |

### 3.2 Identity App (Agent Identity)

Created via the Agent 365 platform (not manually). This is a `ServiceIdentity` type object.

| Property | Value |
|----------|-------|
| `appId` / `id` | `<your-identity-app-id>` |
| `displayName` | `<your-identity-app-display-name>` |
| `@odata.type` | `#microsoft.graph.agentIdentity` |
| `servicePrincipalType` | `ServiceIdentity` |

### 3.3 Blueprint App (Agent Identity Blueprint)

Created via the Agent 365 platform (not manually). This is also platform-managed.

| Property | Value |
|----------|-------|
| `appId` | `<your-blueprint-app-id>` |
| `displayName` | `<your-blueprint-app-display-name>` |
| `@odata.type` | `#microsoft.graph.agentIdentityBlueprint` |
| `identifierUris` | `api://<your-blueprint-app-id>` |

### 3.4 Federated Identity Credential (FIC) — MI → Blueprint

This links the Managed Identity to the Blueprint App, allowing MI to authenticate as the Blueprint:

```bash
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/applications/{blueprint-object-id}/federatedIdentityCredentials" \
  --body '{
    "name": "mi-fic",
    "subject": "<your-mi-principal-id>",
    "issuer": "https://login.microsoftonline.com/<your-tenant-id>/v2.0",
    "audiences": ["api://AzureADTokenExchange"],
    "description": "MI to Blueprint FIC"
  }'
```

| Property | Value |
|----------|-------|
| Subject | MI principalId: `<your-mi-principal-id>` |
| Issuer | `https://login.microsoftonline.com/{tenantId}/v2.0` |
| Audience | `api://AzureADTokenExchange` |

### 3.5 Azure Bot

```bash
az bot create \
  --resource-group <your-resource-group> \
  --name <your-bot-name> \
  --kind azurebot \
  --sku F0 \
  --msa-app-type SingleTenant \
  --msa-app-id <your-identity-app-id> \
  --msa-app-tenant-id <your-tenant-id> \
  --endpoint "https://<your-webapp-name>.azurewebsites.net/api/messages"
```

> **Important**: `msa-app-id` must be the Identity App ID, NOT the Blueprint App ID.

Enable the Teams channel on the bot:
```bash
az bot msteams create --name <your-bot-name> --resource-group <your-resource-group>
```

### 3.6 Azure Web App

```bash
az appservice plan create \
  --name <your-app-service-plan> \
  --resource-group <your-resource-group> \
  --sku B1 --is-linux

az webapp create \
  --name <your-webapp-name> \
  --resource-group <your-resource-group> \
  --plan <your-app-service-plan> \
  --runtime "DOTNETCORE:8.0"
```

Assign the Managed Identity to the Web App:
```bash
az webapp identity assign \
  --name <your-webapp-name> \
  --resource-group <your-resource-group> \
  --identities /subscriptions/{sub-id}/resourceGroups/<your-resource-group>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<your-mi-name>
```

### 3.7 Azure OpenAI

| Property | Value |
|----------|-------|
| Deployment | `gpt-4.1` |
| Endpoint | `<your-azure-openai-endpoint>` |

---

## 4. Permissions & Role Assignments

### 4.1 Blueprint App — Service Principal

Ensure a Service Principal exists for the Blueprint App. The platform may create this automatically.

### 4.2 Identity App — Power Platform API Role

The telemetry exporter sends spans to Power Platform. The Identity App needs the `CopilotStudio.Copilots.Invoke` app role:

```bash
# Find Power Platform API SP
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals" \
  --url-parameters "\$filter=servicePrincipalNames/any(n:n eq 'https://api.powerplatform.com')" "\$select=id,appId,appRoles"

# Power Platform API:
#   appId:  8578e004-a5c6-46e7-913e-12f58912df43
#   SP id:  b95c09d2-1161-47f8-9f47-8f745c645027
#   Role:   CopilotStudio.Copilots.Invoke (38c13204-7d79-4d83-bdbb-b770e28400df)

# Assign the role to the Identity App SP
# Body JSON file:
# {"principalId":"<your-identity-app-id>","resourceId":"b95c09d2-1161-47f8-9f47-8f745c645027","appRoleId":"38c13204-7d79-4d83-bdbb-b770e28400df"}

az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/<your-identity-app-id>/appRoleAssignments" \
  --body @pp-role-body.json \
  --headers "Content-Type=application/json"
```

### 4.3 Redirect URI on Blueprint App

The Blueprint App needs the Bot Framework redirect URI:
```
https://token.botframework.com/.auth/web/redirect
```

### 4.4 Summary of All Permissions

| Principal | Resource | Permission | Type |
|-----------|----------|------------|------|
| Managed Identity | Blueprint App | FIC (Federated Identity Credential) | Federation |
| Blueprint App | Identity App | FMI Path (`WithFmiPath`) | SDK Internal |
| Identity App SP | Power Platform API | `CopilotStudio.Copilots.Invoke` | App Role |
| Identity App SP | Bot Framework | `https://api.botframework.com/.default` | App Token Scope |

### 4.5 Web App Environment Variables

```bash
az webapp config appsettings set \
  --name <your-webapp-name> \
  --resource-group <your-resource-group> \
  --settings \
    SKIP_TOOLING_ON_ERRORS=true \
    ASPNETCORE_ENVIRONMENT=Development
```

---

## 5. Code Changes from Base Sample

The base sample (`agent-framework`) uses a standard App Registration with `ClientSecret` auth. The Blueprint Identity version requires three custom/modified files:

### 5.1 NEW: `BlueprintFmiTokenProvider.cs`

Custom `IAccessTokenProvider` that implements the 3-hop token chain:

```csharp
public class BlueprintFmiTokenProvider : IAccessTokenProvider
{
    private readonly MsalAuth _msalAuth;
    private readonly string _identityAppId;
    private readonly string _tenantId;

    public async Task<string> GetAccessTokenAsync(string resourceUrl, IList<string> scopes, bool forceRefresh = false)
    {
        // Step 1: MI (FIC) → Blueprint → FMI Path → T1 token
        string t1Token = await _msalAuth.GetAgenticApplicationTokenAsync(_tenantId, _identityAppId);

        // Step 2: Use T1 as client assertion to get resource token as Identity App
        var identityClient = ConfidentialClientApplicationBuilder
            .Create(_identityAppId)
            .WithClientAssertion(_ => Task.FromResult(t1Token))
            .WithAuthority($"https://login.microsoftonline.com/{_tenantId}")
            .Build();

        var result = await identityClient
            .AcquireTokenForClient(scopes.ToArray())
            .ExecuteAsync();

        return result.AccessToken;
    }
}
```

**Key SDK method**: `MsalAuth.GetAgenticApplicationTokenAsync(tenantId, identityAppId)` — internally calls `AcquireTokenForClient("api://AzureADTokenExchange/.default").WithFmiPath(identityAppId)`.

### 5.2 MODIFIED: `Program.cs`

**Change 1**: Register custom `IConnections` BEFORE `AddAgent<MyAgent>()`:

```csharp
// Register custom IConnections with BlueprintFmiTokenProvider for bot service auth.
// This MUST be registered BEFORE AddAgent so the SDK uses our provider.
builder.Services.AddSingleton<IConnections>(sp =>
{
    var fmiProvider = new BlueprintFmiTokenProvider(sp, blueprintSection, identityAppId, tenantId, logger);
    var blueprintAuth = new MsalAuth(sp, blueprintSection);

    var connections = new Dictionary<string, IAccessTokenProvider>
    {
        ["BotConnection"] = fmiProvider,          // Custom FMI token provider
        ["BlueprintConnection"] = blueprintAuth   // Standard MsalAuth for agentic flows
    };

    var map = new List<ConnectionMapItem>
    {
        new() { ServiceUrl = "*", Connection = "BotConnection" }  // All outbound → FMI
    };

    return new ConfigurationConnections(connections, map, logger);
});

builder.AddAgent<MyAgent>();  // SDK sees IConnections already registered, skips its own
```

> **Why this works**: The SDK's `AddAgentCore<TAdapter>` only registers `IConnections` if none is already present. By registering ours first, the SDK respects our custom provider.

**Change 2**: Use `AddServiceTracingExporter` instead of `AddAgenticTracingExporter`:

```csharp
// AddAgenticTracingExporter uses IExporterTokenCache<AgenticTokenStruct> which depends on
// UserAuthorization + auth handler — broken without OBO handler.
// AddServiceTracingExporter uses IExporterTokenCache<string> — we supply the token directly.
builder.Services.AddServiceTracingExporter(clusterCategory: "production");
```

### 5.3 MODIFIED: `telemetry/A365OtelWrapper.cs`

Rewritten to use `IExporterTokenCache<string>` + `IAccessTokenProvider` (the FMI provider) instead of `IExporterTokenCache<AgenticTokenStruct>` + `UserAuthorization`:

```csharp
public static async Task InvokeObservedAgentOperation(
    string operationName,
    ITurnContext turnContext,
    ITurnState turnState,
    IExporterTokenCache<string>? serviceTokenCache,  // Changed from AgenticTokenStruct
    IAccessTokenProvider? fmiTokenProvider,           // Changed from UserAuthorization
    ILogger? logger,
    Func<Task> func)
{
    // Resolve agentId from Recipient.Id (strip "28:" Teams prefix)
    string rawAgentId = turnContext?.Activity?.Recipient?.Id ?? Guid.Empty.ToString();
    string agentId = rawAgentId.Contains(':') ? rawAgentId.Substring(rawAgentId.IndexOf(':') + 1) : rawAgentId;
    string tenantId = turnContext?.Activity?.Conversation?.TenantId ?? Guid.Empty.ToString();

    using var baggageScope = new BaggageBuilder()
        .TenantId(tenantId)
        .AgentId(agentId)
        .Build();

    // Acquire Power Platform token via FMI chain
    var token = await fmiTokenProvider!.GetAccessTokenAsync(
        "https://api.powerplatform.com",
        new List<string> { "https://api.powerplatform.com/.default" });

    serviceTokenCache?.RegisterObservability(agentId, tenantId, token, new[] { "https://api.powerplatform.com/.default" });

    await func().ConfigureAwait(false);
}
```

### 5.4 MODIFIED: `Agent/MyAgent.cs`

Constructor and field changes:

```csharp
// Fields — changed from AgenticTokenStruct to string cache + FMI provider
private readonly IExporterTokenCache<string>? _serviceTokenCache = null;
private readonly IAccessTokenProvider? _fmiTokenProvider = null;

// Constructor — inject IConnections to get the FMI provider
public MyAgent(AgentApplicationOptions options,
    IChatClient chatClient,
    IConfiguration configuration,
    IExporterTokenCache<string> serviceTokenCache,  // Changed
    IConnections connections,                        // Added
    IMcpToolRegistrationService toolService,
    ILogger<MyAgent> logger) : base(options)
{
    _serviceTokenCache = serviceTokenCache;
    _fmiTokenProvider = connections.GetConnection("BotConnection");  // The FMI provider
    // ...
}
```

Call site changed:
```csharp
await A365OtelWrapper.InvokeObservedAgentOperation(
    "MessageProcessor",
    turnContext,
    turnState,
    _serviceTokenCache,   // Was _agentTokenCache
    _fmiTokenProvider,    // Was UserAuthorization + authHandlerName
    _logger,
    async () => { /* ... */ });
```

### 5.5 Configuration Changes in `appsettings.json`

| Setting | Base Sample | Blueprint Sample | Reason |
|---------|-------------|------------------|--------|
| `OboAuthHandlerName` | `"me"` | *removed* | Token Service can't work with Identity App |
| `AutoSignin` | `true` | `false` | No sign-in flow possible |
| `DefaultHandlerName` | `"me"` | `"agentic"` | Agentic handler is the default |
| `Microsoft.Agents` log level | `Information` | `Warning` | Reduce verbose MSAL logging |
| `Microsoft.Agents.A365.Observability` | `Debug` | `Information` | Reduce exporter noise |

### 5.6 Development-Only User Assertion OBO Fallback

For local testing without a working Teams/Bot Framework token exchange path, the sample now supports two development-only environment variable fallbacks:

| Environment Variable | Expected Token | Behavior |
|----------------------|----------------|----------|
| `BEARER_TOKEN` | Final downstream delegated MCP token | Used directly as the MCP gateway token override |
| `BLUEPRINT_USER_ASSERTION_TOKEN` | User token whose audience is the Blueprint app | Exchanged through `BlueprintFmiTokenProvider.GetOnBehalfOfAccessTokenAsync()` into a final MCP token for `ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default` |

This path is intentionally development-only. It is useful for validating the Entra agent OBO protocol with a hardcoded or externally acquired user token before the full Teams sign-in path is available.

---

## 6. Configuration (appsettings.json)

Full reference configuration:

```json
{
  "AgentApplication": {
    "StartTypingTimer": false,
    "RemoveRecipientMention": false,
    "NormalizeMentions": false,
    "AgenticAuthHandlerName": "agentic",
    "UserAuthorization": {
      "AutoSignin": false,
      "DefaultHandlerName": "agentic",
      "Handlers": {
        "me": {
          "Settings": {
            "AzureBotOAuthConnectionName": "BlueprintOAuth",
            "OBOConnectionName": "BlueprintConnection"
          }
        },
        "agentic": {
          "Type": "AgenticUserAuthorization",
          "Settings": {
            "Scopes": ["https://graph.microsoft.com/.default"],
            "AlternateBlueprintConnectionName": "BlueprintConnection"
          }
        }
      }
    }
  },
  "TokenValidation": {
    "Enabled": false,
    "Audiences": ["<Blueprint App ID>"],
    "TenantId": "<Tenant ID>"
  },
  "EnableAgent365Exporter": true,
  "BlueprintIdentity": {
    "IdentityAppId": "<Identity App ID>",
    "TenantId": "<Tenant ID>"
  },
  "Connections": {
    "BlueprintConnection": {
      "Settings": {
        "AuthType": "FederatedCredentials",
        "ClientId": "<Blueprint App ID>",
        "FederatedClientId": "<Managed Identity Client ID>",
        "TenantId": "<Tenant ID>",
        "Scopes": ["https://api.botframework.com/.default"]
      }
    }
  },
  "AIServices": {
    "AzureOpenAI": {
      "DeploymentName": "<deployment-name>",
      "Endpoint": "<endpoint-url>",
      "ApiKey": "<api-key>"
    }
  }
}
```

### Key Configuration Mapping

| Config Path | Points To | Why |
|-------------|-----------|-----|
| `Connections:BlueprintConnection:Settings:ClientId` | Blueprint App ID | MI authenticates AS the Blueprint |
| `Connections:BlueprintConnection:Settings:FederatedClientId` | MI Client ID | The MI that has the FIC |
| `Connections:BlueprintConnection:Settings:AuthType` | `FederatedCredentials` | Tells MsalAuth to use MI federation |
| `BlueprintIdentity:IdentityAppId` | Identity App ID | Target for FMI path token assertion |
| `TokenValidation:Audiences` | Blueprint App ID | Incoming tokens are scoped to Blueprint |

---

## 7. Teams App Manifest

The `manifest.json` must reference the **Identity App ID** (not the Blueprint) in all identity fields:

```json
{
  "id": "<Identity App ID>",
  "webApplicationInfo": {
    "id": "<Identity App ID>",
    "resource": "api://botid-<Identity App ID>"
  },
  "bots": [{
    "botId": "<Identity App ID>"
  }],
  "validDomains": ["<your-webapp>.azurewebsites.net"]
}
```

---

## 8. Build & Deploy

```powershell
# Build
cd sample-agent
dotnet publish -c Release -o ./publish

# Zip
Compress-Archive -Path ./publish/* -DestinationPath publish.zip

# Deploy
az webapp deploy \
  --name <your-webapp-name> \
  --resource-group <your-resource-group> \
  --src-path publish.zip \
  --type zip

# Verify
Invoke-RestMethod "https://<your-webapp-name>.azurewebsites.net/api/health"
# Expected: { "status": "healthy", "timestamp": "..." }
```

Upload the Teams app package (zip of `manifest.json` + icons) via Teams Admin Center or sideloading.

---

## 9. Authentication Flow Deep-Dive

### 9.1 Bot Service Auth (Replying to Messages)

When the bot needs to send a reply to Teams, the SDK's `CloudAdapter` calls `IConnections` → `BotConnection` → `BlueprintFmiTokenProvider.GetAccessTokenAsync`:

```
Step 0: Web App starts with User-Assigned MI (client: <mi-client-id>)
         ↓
Step 1: MsalAuth creates ConfidentialClient for Blueprint App (<blueprint-app-id>)
        using MI token via FederatedCredentials (FIC subject: <mi-principal-id>)
         ↓
Step 2: Blueprint.AcquireTokenForClient("api://AzureADTokenExchange/.default")
        .WithFmiPath("<identity-app-id>")  ← Identity App ID
        → T1 (assertion token proving Blueprint can act as Identity)
         ↓
Step 3: New ConfidentialClient(identityAppId: <identity-app-id>)
        .WithClientAssertion(T1)
        .AcquireTokenForClient("https://api.botframework.com/.default")
        → T2 (Bot Framework token as Identity App)
         ↓
Step 4: CloudAdapter uses T2 to POST reply to Bot Framework → Teams
```

### 9.2 Telemetry Export (Power Platform)

Same FMI token chain but with a different target scope:

```
BlueprintFmiTokenProvider.GetAccessTokenAsync(
    "https://api.powerplatform.com",
    ["https://api.powerplatform.com/.default"])
→ Token as Identity App scoped to Power Platform API
→ Agent365Exporter sends spans to Power Platform traces endpoint
```

### 9.3 Why Standard SDK AuthTypes Don't Work

| Attempt | AuthType | Result | Root Cause |
|---------|----------|--------|------------|
| 1 | `UserManagedIdentity` (ClientId=Blueprint) | "MI not found" | Blueprint isn't an MI |
| 2 | `FederatedCredentials` (standard) | `AADSTS82001` | SDK path doesn't do FMI hop |
| 3 | `ClientSecret` (Blueprint) | `AADSTS82001` | Blueprint isn't a real App Reg |
| 4 | `UserManagedIdentity` (SDK 1.5.x) | "MI not found" | Same as attempt 1 |
| 5 | **Custom `BlueprintFmiTokenProvider`** | **Works** | Uses internal `GetAgenticApplicationTokenAsync` + `WithFmiPath` |

---

## 10. SDK Auth Limitations for Blueprint + Identity

The Microsoft Agents SDK (v1.5.x-beta) was not designed to natively support the Blueprint + Identity authentication model. Below is a detailed analysis of what the SDK provides, what gaps exist, and why a custom token provider is necessary.

### 10.1 SDK `AuthTypes` — What's Built In

The SDK's `MsalAuth` class (in `Microsoft.Agents.Authentication.Msal`) supports 7 auth types via the `AuthTypes` enum:

| AuthType | How It Authenticates | Works with Blueprint+Identity? |
|----------|---------------------|-------------------------------|
| `Certificate` | X.509 cert on the App Reg | No — Identity App has no cert |
| `CertificateSubjectName` | Cert matched by subject name | No — same reason |
| `ClientSecret` | Client secret on the App Reg | No — Identity App has no secret |
| `UserManagedIdentity` | User-assigned MI's clientId must match the App Reg | No — MI clientId ≠ Blueprint's appId |
| `SystemManagedIdentity` | System-assigned MI on the host | No — doesn't chain to Blueprint |
| `FederatedCredentials` | MI + FIC + `AcquireTokenForClient` | **Partial** — Gets a Blueprint token, not an Identity token |
| `WorkloadIdentity` | Kubernetes workload identity | No — not applicable |

**The gap**: `FederatedCredentials` gets you a token **as the Blueprint App**, but the bot's `msaAppId` is the **Identity App**. Bot Framework requires the token's `appId` claim to match the bot's `msaAppId`. There's no built-in auth type that chains from MI → Blueprint → Identity.

### 10.2 The Internal `GetAgenticApplicationTokenAsync` Method

The SDK **does** have the FMI path capability built in — it's just not exposed as a standard `AuthType`:

```csharp
// Inside MsalAuth (decompiled):
public async Task<string> GetAgenticApplicationTokenAsync(string tenantId, string targetAppId)
{
    // Step 1: Create ConfidentialClient as Blueprint (using FederatedCredentials / MI FIC)
    var app = InnerCreateClientApplication();
    
    // Step 2: AcquireTokenForClient with FMI path
    var result = await app
        .AcquireTokenForClient(new[] { "api://AzureADTokenExchange/.default" })
        .WithFmiPath(targetAppId)  // ← This is the key MSAL feature
        .WithTenantId(tenantId)
        .ExecuteAsync();
    
    return result.AccessToken;
}
```

This method produces a T1 token (an assertion that can be used as a client credential for the Identity App), but:
- It's **not** called by any standard `IAccessTokenProvider.GetAccessTokenAsync()` implementation in the SDK
- It's called internally only by `AgenticUserAuthorization` for agentic request flows (user-context, not app-context)
- There's no `AuthType` value like `"BlueprintFmiPath"` that would trigger this for outbound bot service calls

### 10.3 `UserAuthorization` Handler Types — What They Do

The SDK's `UserAuthorizationModuleLoader` recognizes 3 handler types:

| Handler Type | Config Key | What It Does | Works for Bot Service Auth? |
|-------------|-----------|-------------|---------------------------|
| `AzureBotUserAuthorization` | (default) | Uses Bot Framework Token Service to get/store user tokens via OAuth card | No — Token Service requires real App Reg as `msaAppId` |
| `AgenticUserAuthorization` | `"AgenticUserAuthorization"` | Uses `IAgenticTokenProvider.GetAgenticUserTokenAsync()` for A365 agentic requests | No — designed for user-context in agentic calls, not app-level bot auth |
| `ConnectorUserAuthorization` | `"ConnectorUserAuthorization"` | Reads bearer token from incoming activity's `Authorization` header, does OBO exchange | No — requires inbound bearer token; not available in standard Teams messages |

None of these solve the core problem: **getting an app-level token as the Identity App for outbound Bot Framework calls**.

### 10.4 The DI Registration Gap

The SDK's `AddAgentCore<TAdapter>` method registers `IConnections` using `ConfigurationConnections`, which creates `MsalAuth` instances based on the `AuthType` in config. The entire token acquisition pipeline assumes:

1. `IConnections` resolves a named connection (e.g., `"BotConnection"`)
2. That connection's `IAccessTokenProvider` returns a token based on one of the 7 `AuthTypes`
3. The token's `appId` matches the bot's `msaAppId`

With Blueprint + Identity, step 3 fails because none of the 7 auth types can produce a token **as the Identity App** — they can only produce tokens as the Blueprint App or the MI.

### 10.5 What the SDK Would Need to Support This Natively

A potential future SDK enhancement would be a new `AuthType` (e.g., `"BlueprintIdentity"`) that:

1. Reads `ClientId` (Blueprint), `FederatedClientId` (MI), and `IdentityAppId` from config
2. Uses `FederatedCredentials` to authenticate as Blueprint via MI FIC
3. Calls `GetAgenticApplicationTokenAsync(tenantId, identityAppId)` to get the T1 assertion
4. Creates a new `ConfidentialClientApplication` as the Identity App with T1 as client assertion
5. Calls `AcquireTokenForClient(scopes)` to get the final resource token

This is exactly what our `BlueprintFmiTokenProvider` does manually. Until the SDK adds native support, the custom provider pattern shown in this guide is required.

### 10.6 `AddAgenticTracingExporter` vs `AddServiceTracingExporter`

| Exporter | Token Cache Type | How It Gets Power Platform Token | Works with Blueprint+Identity? |
|----------|-----------------|--------------------------------|-------------------------------|
| `AddAgenticTracingExporter` | `IExporterTokenCache<AgenticTokenStruct>` | Stores `UserAuthorization` + `AuthHandlerName`, calls `GetTurnTokenAsync` at export time | No — requires a working auth handler that can produce tokens |
| `AddServiceTracingExporter` | `IExporterTokenCache<string>` | Expects a pre-acquired token string registered via `RegisterObservability` | **Yes** — we supply the token from our FMI provider |

The agentic exporter is designed for scenarios where the bot has a fully functional `UserAuthorization` pipeline. Since Blueprint+Identity breaks that pipeline (no `OboAuthHandlerName`), the service exporter with manual token acquisition is the correct choice.

---

## 11. Known Limitations

### 10.1 No User Token Acquisition

Bot Framework Token Service requires the bot's `msaAppId` to be a real App Registration to store/retrieve user tokens. Since the Identity App is a platform-managed `ServiceIdentity`:

- **SSO (Single Sign-On)** does not work
- **OAuth Card sign-in** fails with "Invalid sign in code"
- **On-Behalf-Of (OBO)** token flow is not functional

This means:
- `OboAuthHandlerName` must be removed from config
- `AutoSignin` must be `false`
- MCP tools that require user tokens will not work
- Only app-level (application-permission) API calls are possible

### 11.2 MCP Tools

MCP tools from the Agent 365 tooling service require user tokens to register tools per-user. Without user tokens, MCP tools cannot be loaded. Set `SKIP_TOOLING_ON_ERRORS=true` to allow the agent to fall back to local tools only.

### 11.3 Platform-Managed Objects

The Identity App and Blueprint App cannot be modified like normal App Registrations:
- Cannot create client secrets or certificates on them
- Cannot modify redirect URIs on the Identity App
- Standard Graph API endpoints for app management may return empty or error for these objects

---

## 12. Troubleshooting

### "MI not found" errors
- Ensure the User-Assigned MI is assigned to the Web App
- Ensure `FederatedClientId` in config is the MI's **clientId**, not principalId

### `AADSTS82001`
- Standard SDK auth types can't handle Blueprint+Identity. Use `BlueprintFmiTokenProvider`.

### `Agent365Exporter: No spans with tenant/agent identity found`
- The `A365OtelWrapper` is not correctly resolving `agentId` and `tenantId`
- Ensure `Recipient.Id` fallback is in place (strip "28:" prefix)

### `Agent365Exporter: HTTP 401`
- **If using `AddAgenticTracingExporter`**: Switch to `AddServiceTracingExporter` + custom token acquisition via FMI provider
- **If already using `AddServiceTracingExporter`**: Ensure the Identity App SP has the `CopilotStudio.Copilots.Invoke` role on the Power Platform API SP
- Restart the Web App after granting roles to clear MSAL token cache

### Sign-in popup shows "Something went wrong" or "Invalid sign in code"
- This is a fundamental limitation. Remove `OboAuthHandlerName`, set `AutoSignin: false`.

### `ObjectDisposedException: Cannot access a disposed object. Object name: 'HttpRequestStream'`
- Kestrel crash caused by empty sign-in handlers. Ensure `OboAuthHandlerName` is completely removed from config (not just set to empty string).

---

## Resource Summary Table

| Resource | Name | ID/Value |
|----------|------|----------|
| Tenant | a365preview070 | `<your-tenant-id>` |
| Subscription | — | `<subscription-id>` |
| Resource Group | — | `<your-resource-group>` |
| Managed Identity | `<your-mi-name>` | clientId: `<your-mi-client-id>`, principalId: `<your-mi-principal-id>` |
| Identity App | `<your-identity-app-display-name>` | `<your-identity-app-id>` |
| Blueprint App | `<your-blueprint-app-display-name>` | `<your-blueprint-app-id>` |
| Bot | `<your-bot-name>` | msaAppId: `<identity-app-id>` (Identity App) |
| Web App | `<your-webapp-name>` | `https://<your-webapp-name>.azurewebsites.net` |
| App Service Plan | `<your-app-service-plan>` | Linux, B1 |
| Azure OpenAI | `<your-openai-resource>` | `gpt-4.1` deployment |
| Power Platform API | (tenant SP) | appId: `8578e004-a5c6-46e7-913e-12f58912df43` |

---

## File Inventory

| File | Status | Purpose |
|------|--------|---------|
| `BlueprintFmiTokenProvider.cs` | **NEW** | Custom `IAccessTokenProvider` — 3-hop FMI token chain |
| `Program.cs` | **MODIFIED** | Custom `IConnections` DI, `AddServiceTracingExporter` |
| `Agent/MyAgent.cs` | **MODIFIED** | `IExporterTokenCache<string>` + `IConnections` injection |
| `telemetry/A365OtelWrapper.cs` | **MODIFIED** | FMI-based Power Platform token for telemetry |
| `appsettings.json` | **MODIFIED** | Blueprint connection, identity config, auth handlers |
| `appPackage/manifest.json` | **MODIFIED** | Identity App ID in all identity fields |
