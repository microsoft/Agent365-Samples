# A365 SDK Gap Analysis: Blueprint + Identity Authentication

**Author:** Mehul Bhatt  
**Date:** March 27, 2026  
**SDK Version:** Microsoft.Agents SDK 1.5.x-beta  
**Status:** Draft — Proposal for SDK Enhancement

---

## 1. Executive Summary

The Microsoft Agents SDK does not natively support the **Blueprint + Identity** authentication model introduced by the Agent 365 platform. This model uses two platform-managed Entra objects — a **Blueprint** (credential broker) and an **Identity** (actor principal) — instead of traditional App Registrations. The SDK's built-in `AuthType` values cannot produce tokens as the Identity App, forcing developers to build a custom `IAccessTokenProvider` with 120+ lines of MSAL code and manually wire DI before the SDK's `AddAgent<T>()` call.

This document identifies the specific gaps, documents workarounds implemented, and proposes SDK-level solutions.

---

## 2. Background: What Is Blueprint + Identity?

The Agent 365 platform provisions two platform-managed Entra objects per agent:

| Object | Entra Type | Role | Has Credentials? |
|--------|-----------|------|-------------------|
| **Blueprint** (`agentIdentityBlueprint`) | Service Principal with identifierUris | Credential broker. Holds client secrets or accepts MI FIC. Parent of Identity. | Yes — can have secrets, FIC |
| **Identity** (`agentIdentity`) | Service Principal (`ServiceIdentity` type) | The agent's actor principal. Used as `msaAppId` on the Azure Bot, appears in manifest, audit logs, consent records. | **No** — no secret, no certificate, no direct auth |

### The Fundamental Problem

The bot's `msaAppId` is the Identity App. Bot Framework requires that outbound tokens have an `appid` claim matching `msaAppId`. But the Identity App has no credentials — you cannot create a `ConfidentialClientApplication` for it directly.

The only way to authenticate as the Identity App is through a **3-hop token chain**:

```
Hop 1: Authenticate as Blueprint (via MI FIC or client secret)
Hop 2: Blueprint.AcquireTokenForClient(.WithFmiPath(identityAppId)) → T1 assertion
Hop 3: ConfidentialClient(identityAppId, T1).AcquireTokenForClient(resource) → final token
```

For user-delegated (OBO) flows, a 4th hop is added:

```
Hop 4: ConfidentialClient(identityAppId, T1).AcquireTokenOnBehalfOf(scopes, userAssertion) → delegated token
```

---

## 3. Gap Analysis

### 3.1 Gap: No `AuthType` for Blueprint → Identity Chain

**Current state:** The SDK's `MsalAuth` class supports 7 `AuthType` values:

| AuthType | Authentication Method | Produces Token As |
|----------|----------------------|-------------------|
| `Certificate` | X.509 certificate | The configured `ClientId` |
| `CertificateSubjectName` | Certificate by subject name | The configured `ClientId` |
| `ClientSecret` | Client ID + secret | The configured `ClientId` |
| `UserManagedIdentity` | User-assigned MI token | The MI itself |
| `SystemManagedIdentity` | System-assigned MI token | The MI itself |
| `FederatedCredentials` | MI FIC → ConfidentialClient | The configured `ClientId` (Blueprint) |
| `WorkloadIdentity` | Kubernetes workload identity | The configured `ClientId` |

**The gap:** All 7 types produce a token as the **configured `ClientId`** — which is Blueprint. None produces a token as the **Identity App**. The FMI path (Hop 2 + 3) is not triggered by any standard code path for `IAccessTokenProvider.GetAccessTokenAsync()`.

**Impact:** Developers must write a custom `IAccessTokenProvider` (`BlueprintFmiTokenProvider`, ~120 lines) and pre-register it in DI before `AddAgent<T>()`.

**Evidence:** The SDK *does* have the FMI capability internally — `MsalAuth.GetAgenticApplicationTokenAsync()` calls `.WithFmiPath()`. But this method is only called by `AgenticUserAuthorization` for user-context flows, never for app-level `GetAccessTokenAsync()`.

### 3.2 Gap: `IConnections` DI Registration Assumes Standard AuthTypes

**Current state:** `AddAgent<T>()` → `AddAgentCore<TAdapter>()` registers `IConnections` using `ConfigurationConnections`, which instantiates `MsalAuth` per connection based on config. There is no extension point to inject a custom `IAccessTokenProvider` for a named connection without pre-empting the SDK's DI registration.

**The gap:** To use a custom provider, developers must register `IConnections` as a singleton **before** calling `AddAgent<T>()`, relying on the DI container's "first-registration-wins" behavior:

```csharp
// Must come BEFORE AddAgent<MyAgent>()
builder.Services.AddSingleton<IConnections>(sp => {
    var fmiProvider = new BlueprintFmiTokenProvider(...);
    var connections = new Dictionary<string, IAccessTokenProvider>
    {
        ["BotConnection"] = fmiProvider
    };
    return new ConfigurationConnections(connections, map, logger);
});

builder.AddAgent<MyAgent>();  // SDK won't overwrite IConnections
```

**Impact:** Fragile ordering dependency. If the SDK changes its DI behavior (e.g., replaces instead of skips existing registrations), this pattern breaks silently.

### 3.3 Gap: `AddAgenticTracingExporter` Depends on UserAuthorization Pipeline

**Current state:** `AddAgenticTracingExporter` registers `IExporterTokenCache<AgenticTokenStruct>` which stores a `UserAuthorization` reference and auth handler name. At export time, it calls `GetTurnTokenAsync()` to get a Power Platform token.

**The gap:** This requires a functioning `UserAuthorization` pipeline with a configured auth handler. With Blueprint+Identity:
- `OboAuthHandlerName` can't be set (no working OBO handler)
- `AgenticAuthHandlerName` produces tokens via `GetAgenticUserTokenAsync()` which works for user-context but not for the exporter's standalone export cycle (no `ITurnContext` available)

**Impact:** Developers must use `AddServiceTracingExporter` (which accepts raw token strings) and manually acquire Power Platform tokens via the FMI provider during each turn.

### 3.4 Gap: Bot Framework Token Service Incompatibility

**Current state:** Bot Framework Token Service (`token.botframework.com`) manages OAuth connections (like `BlueprintOAuth`) for user sign-in. It requires the bot's `msaAppId` to be a real App Registration that it can validate tokens against.

**The gap:** The Identity App is `ServiceIdentity` type, not a real App Registration. Token Service cannot:
- Store/retrieve user tokens for it
- Perform OAuth card sign-in flows
- Validate token exchange requests

**Impact:**
- User sign-in via OAuth cards fails ("Invalid sign in code")
- SSO (Single Sign-On) cannot be initiated
- `AutoSignin` must be `false`
- `OboAuthHandlerName` must be unset
- MCP tools requiring user tokens must use alternative token delivery (e.g., API endpoint with `Authorization` header)

### 3.5 Gap: `Utility.ResolveAgentIdentity` Requires `ITurnContext`

**Current state:** `Utility.ResolveAgentIdentity(ITurnContext, string)` resolves the agent's identity from a token. No overload accepts just a token string.

**The gap:** In standalone API endpoints (like `/api/obo-chat`) that bypass Bot Framework, there is no `ITurnContext`. Developers must manually decode the JWT to extract the `azp`/`appid` claim.

**Impact:** Minor — JWT decoding is straightforward, but a `ResolveAgentIdentity(string token)` overload would reduce boilerplate.

### 3.6 Gap: `GetMcpToolsAsync` Requires `ITurnContext`

**Current state:** `IMcpToolRegistrationService.GetMcpToolsAsync()` accepts `ITurnContext` as a parameter. The underlying `McpToolServerConfigurationService.CreateMcpClientWithAuthHandlers()` uses `ITurnContext` for MCP client creation.

**The gap:** When calling from standalone endpoints (no Bot Framework pipeline), `ITurnContext` is null. Some MCP servers (e.g., `mcp_TeamsServerV1`) throw `ObjectDisposedException` ("CancellationTokenSource has been disposed") when `ITurnContext` is null.

**Impact:** MCP tool loading partially works (most servers load fine), but some servers fail. The error is non-fatal but produces noise in logs.

---

## 4. Workarounds Implemented

### 4.1 Custom `BlueprintFmiTokenProvider`

A custom `IAccessTokenProvider` that implements the full 3-hop chain:

```csharp
public class BlueprintFmiTokenProvider : IAccessTokenProvider
{
    private readonly MsalAuth _msalAuth; // Handles Hop 1 (MI FIC or ClientSecret → Blueprint)

    public async Task<string> GetAccessTokenAsync(string resourceUrl, IList<string> scopes, bool forceRefresh = false)
    {
        // Hop 2: FMI path → T1
        string t1 = await _msalAuth.GetAgenticApplicationTokenAsync(_tenantId, _identityAppId);

        // Hop 3: T1 as assertion → resource token as Identity
        var identityClient = ConfidentialClientApplicationBuilder
            .Create(_identityAppId)
            .WithClientAssertion(_ => Task.FromResult(t1))
            .Build();
        var result = await identityClient.AcquireTokenForClient(scopes).ExecuteAsync();
        return result.AccessToken;
    }

    public async Task<string> GetOnBehalfOfAccessTokenAsync(IList<string> scopes, string userAssertion)
    {
        // Hop 2: FMI path → T1
        string t1 = await _msalAuth.GetAgenticApplicationTokenAsync(_tenantId, _identityAppId);

        // Hop 3+4: T1 as assertion → OBO exchange → delegated token
        var identityClient = ConfidentialClientApplicationBuilder
            .Create(_identityAppId)
            .WithClientAssertion(_ => Task.FromResult(t1))
            .Build();
        var result = await identityClient
            .AcquireTokenOnBehalfOf(scopes, new UserAssertion(userAssertion))
            .ExecuteAsync();
        return result.AccessToken;
    }
}
```

### 4.2 Pre-emptive `IConnections` Registration

Register `IConnections` before `AddAgent<T>()` to override the SDK's default registration:

```csharp
builder.Services.AddSingleton<IConnections>(sp => {
    var fmiProvider = new BlueprintFmiTokenProvider(sp, blueprintSection, identityAppId, tenantId, logger);
    var connections = new Dictionary<string, IAccessTokenProvider>
    {
        ["BotConnection"] = fmiProvider,
        ["BlueprintConnection"] = new MsalAuth(sp, blueprintSection)
    };
    var map = new List<ConnectionMapItem> { new() { ServiceUrl = "*", Connection = "BotConnection" } };
    return new ConfigurationConnections(connections, map, logger);
});
```

### 4.3 `AddServiceTracingExporter` with Manual Token

Use the service exporter and manually acquire Power Platform tokens:

```csharp
builder.Services.AddServiceTracingExporter(clusterCategory: "production");

// In A365OtelWrapper:
var ppToken = await fmiTokenProvider.GetAccessTokenAsync("https://api.powerplatform.com", ...);
serviceTokenCache.RegisterObservability(ppToken, agentId, tenantId);
```

### 4.4 Standalone API Endpoints for OBO Testing

Since Bot Framework's `/api/messages` endpoint requires channel auth, standalone endpoints bypass the adapter:

- `/api/obo-test` — Performs OBO exchange and returns token metadata (proves the chain works)
- `/api/obo-chat` — Full flow: OBO exchange → MCP tool loading → LLM invocation → response

### 4.5 Admin Consent for OBO

The Identity App (`agentIdentity`) has no portal consent UI. Admin consent for delegated permissions on downstream resources (e.g., MCP Gateway) must be granted via Graph API:

```bash
az rest --method POST --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" \
  --body '{"clientId":"<identity-sp-id>","consentType":"AllPrincipals","resourceId":"<resource-sp-id>","scope":"McpServers.Mail.All ..."}'
```

---

## 5. Proposed SDK Solutions

### 5.1 New `AuthType: BlueprintIdentity`

**Priority: High**

Add a new `AuthType` enum value that natively handles the 3-hop chain:

```json
{
  "Connections": {
    "BotConnection": {
      "Settings": {
        "AuthType": "BlueprintIdentity",
        "ClientId": "<blueprint-app-id>-...",           // Blueprint App ID
        "IdentityAppId": "<identity-app-id>-...",      // Identity App ID (target of FMI)
        "TenantId": "<tenant-id>-...",
        "ClientSecret": "...",                // OR FederatedClientId for MI FIC
        "FederatedClientId": "<mi-client-id>-..."   // Optional: MI for FIC bootstrap
      }
    }
  }
}
```

**Implementation in `MsalAuth`:**

```csharp
case AuthTypes.BlueprintIdentity:
    // Step 1: Bootstrap as Blueprint (ClientSecret or FederatedCredentials)
    var blueprintApp = InnerCreateClientApplication(); // existing code

    // Step 2: FMI path to get T1
    var t1 = await blueprintApp
        .AcquireTokenForClient(new[] { "api://AzureAdTokenExchange/.default" })
        .WithFmiPath(settings.IdentityAppId)
        .WithTenantId(settings.TenantId)
        .ExecuteAsync();

    // Step 3: Acquire resource token as Identity
    var identityApp = ConfidentialClientApplicationBuilder
        .Create(settings.IdentityAppId)
        .WithClientAssertion(_ => Task.FromResult(t1.AccessToken))
        .WithAuthority($"https://login.microsoftonline.com/{settings.TenantId}")
        .Build();
    return await identityApp.AcquireTokenForClient(scopes).ExecuteAsync();
```

**Eliminates:** Custom `BlueprintFmiTokenProvider`, pre-emptive DI registration, 120+ lines of custom code.

### 5.2 `IAccessTokenProvider` Extension Point on `IConnections`

**Priority: Medium**

Allow developers to register custom `IAccessTokenProvider` instances for specific connection names without pre-empting the entire `IConnections` registration:

```csharp
builder.Services.AddAgent<MyAgent>(options => {
    options.Connections.AddProvider("BotConnection", sp => {
        return new BlueprintFmiTokenProvider(...);
    });
});
```

This would work alongside the SDK's standard config-based connections, not replace them.

### 5.3 OBO Support in `BlueprintIdentity` AuthType

**Priority: Medium**

Extend the new `BlueprintIdentity` auth type to support OBO via a new method on `IAccessTokenProvider`:

```csharp
public interface IAccessTokenProvider
{
    // Existing
    Task<string> GetAccessTokenAsync(string resourceUrl, IList<string> scopes, bool forceRefresh = false);

    // New — OBO exchange
    Task<string> GetOnBehalfOfAccessTokenAsync(
        IList<string> scopes,
        string userAssertionToken,
        bool forceRefresh = false) => throw new NotSupportedException();
}
```

The `BlueprintIdentity` implementation would:
1. Get T1 via FMI path (same as app-only)
2. Call `AcquireTokenOnBehalfOf` instead of `AcquireTokenForClient`

### 5.4 `AddAgenticTracingExporter` Fallback to Service Token

**Priority: Low**

Allow `AddAgenticTracingExporter` to accept a fallback `IAccessTokenProvider` for scenarios where `UserAuthorization` is unavailable:

```csharp
builder.Services.AddAgenticTracingExporter(config => {
    config.ClusterCategory = "production";
    config.FallbackTokenProvider = sp => sp.GetService<BlueprintFmiTokenProvider>();
});
```

### 5.5 `Utility.ResolveAgentIdentity(string token)` Overload

**Priority: Low**

Add a token-only overload that decodes the JWT and extracts `azp`/`appid`:

```csharp
public static string? ResolveAgentIdentity(string accessToken)
{
    // Decode JWT payload, return azp or appid claim
}
```

### 5.6 `GetMcpToolsAsync` Null-Safe for `ITurnContext`

**Priority: Low**

Make `McpToolServerConfigurationService.CreateMcpClientWithAuthHandlers` handle null `ITurnContext` gracefully instead of throwing `ObjectDisposedException` when the `CancellationTokenSource` from the context is missing.

---

## 6. Configuration Comparison

### Before (Standard App Registration)

```json
{
  "Connections": {
    "BotConnection": {
      "Settings": {
        "AuthType": "ClientSecret",
        "ClientId": "<app-registration-id>",
        "ClientSecret": "<secret>",
        "TenantId": "<tenant-id>"
      }
    }
  }
}
```

**Custom code required:** None — SDK handles everything.

### After (Blueprint + Identity — Current Workaround)

```json
{
  "BlueprintIdentity": {
    "IdentityAppId": "<identity-app-id>-...",
    "TenantId": "<tenant-id>-..."
  },
  "Connections": {
    "BlueprintConnection": {
      "Settings": {
        "AuthType": "ClientSecret",
        "ClientId": "<blueprint-app-id>-...",
        "ClientSecret": "<blueprint-secret>",
        "TenantId": "<tenant-id>-..."
      }
    }
  }
}
```

**Custom code required:**
- `BlueprintFmiTokenProvider.cs` (~120 lines)
- Pre-emptive `IConnections` DI registration (~20 lines)
- Modified `A365OtelWrapper.cs` (service exporter pattern)
- Standalone API endpoints for OBO testing

### After (Proposed SDK Change)

```json
{
  "Connections": {
    "BotConnection": {
      "Settings": {
        "AuthType": "BlueprintIdentity",
        "ClientId": "<blueprint-app-id>-...",
        "IdentityAppId": "<identity-app-id>-...",
        "ClientSecret": "<blueprint-secret>",
        "TenantId": "<tenant-id>-..."
      }
    }
  }
}
```

**Custom code required:** None — SDK handles everything, same as standard App Registration.

---

## 7. Bootstrap Method Comparison

The Blueprint can be authenticated via two methods. Both feed into the same FMI path:

| Method | Config | Requires | Security Model |
|--------|--------|----------|---------------|
| **MI FIC** (Federated Credentials) | `AuthType: FederatedCredentials`, `FederatedClientId: <MI clientId>` | User-Assigned MI assigned to Web App + FIC configured on Blueprint | Secretless — MI token is issued by Azure platform, no credentials to rotate |
| **Client Secret** | `AuthType: ClientSecret`, `ClientSecret: <value>` | Secret created on Blueprint SP | Secret must be rotated before expiry; stored securely |

Both are validated and working. The FMI path (Hop 2 + 3) is identical regardless of bootstrap method.

---

## 8. Summary of Gaps and Priorities

| # | Gap | Impact | Workaround Complexity | Proposed Fix | Priority |
|---|-----|--------|----------------------|-------------|----------|
| 3.1 | No `AuthType` for Blueprint→Identity | **High** — blocks all Blueprint+Identity agents | 120+ lines custom code | New `AuthType: BlueprintIdentity` | **High** |
| 3.2 | No `IConnections` extension point | **Medium** — fragile DI ordering | Pre-emptive singleton registration | Connection provider factory | **Medium** |
| 3.3 | Tracing exporter depends on UserAuth | **Medium** — can't use agentic exporter | Switch to service exporter | Fallback token provider option | **Low** |
| 3.4 | Token Service incompatible with ServiceIdentity | **High** — no user sign-in | Standalone OBO endpoints | Platform-level fix (not SDK) | **Platform** |
| 3.5 | `ResolveAgentIdentity` needs ITurnContext | **Low** — easy manual decode | Manual JWT decode | Add overload | **Low** |
| 3.6 | MCP tools crash on null ITurnContext | **Low** — non-fatal, log noise | Catch and log exception | Null-safe context handling | **Low** |

---

## 9. References

- [Agent OAuth Flows: On behalf of flow](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/agent-oauth-obo-flow) — Microsoft Learn article validating the OBO protocol
- [Blueprint Identity Setup Guide](./blueprint-identity-setup-guide.md) — Full setup and deployment guide for this sample
- [Microsoft.Identity.Client WithFmiPath](https://learn.microsoft.com/en-us/entra/identity-platform/federated-managed-identity) — MSAL FMI documentation
- Sample code: `BlueprintFmiTokenProvider.cs`, `Program.cs`, `Agent/MyAgent.cs`
