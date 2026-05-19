# Missing `AddAgentIdentities()` Causes AADSTS7000215 on First Turn

## Symptom

When the bot receives its first message, all MCP client token acquisitions fail with:

```
ErrorCode: invalid_client
HTTP StatusCode 401
Microsoft Entra ID Error Code AADSTS7000215
```

MSAL logs show `Token Acquisition (1007) failed` — one failure per MCP server (4 servers = 4 failures, all at the same timestamp). Subsequent turns may succeed because MSAL caches tokens from a degraded fallback path.

## Root Cause

`WithAgentUserIdentity()` (from `Microsoft.Identity.Web.AgentIdentities`) configures `AuthorizationHeaderProviderOptions` with:

- `ClientId` set to the **agent application ID** (e.g., `9218bdba-...`)
- `AgentIdentityKey` and `UserIdKey` in `ExtraParameters`

These parameters are designed for the **FIC (Federated Identity Credential)** grant flow (`grant_type=user_fic`), which is a two-step process:

1. Acquire a FIC token for the agent app using the **blueprint's client credentials** (from the `AzureAd` config section)
2. Exchange that for a user FIC assertion scoped to the agent identity

The MSAL add-in that implements this flow (`AgentUserIdentityMsalAddIn.OnBeforeUserFicForAgentUserIdentityAsync`) is registered by calling `services.AddAgentIdentities()`. **If this call is missing**, MSAL never hooks the FIC handler and falls back to a standard silent token acquisition where:

- `client_id` = agent application ID (`9218bdba-...`) — set by `WithAgentUserIdentity`
- `client_secret` = the blueprint's secret (from the `AzureAd` config, which has `ClientId = 74018ebb-...`)

Entra ID rejects this because the secret does not belong to the agent application — it belongs to the blueprint. This produces `AADSTS7000215` (`invalid_client`).

## Fix

Register the Agent Identities MSAL add-in in your DI setup:

```csharp
using Microsoft.Identity.Web;

services.AddAgentIdentities();
```

This registers the `OnBeforeTokenAcquisitionForTestUserAsync` callback that intercepts token requests with agent identity parameters and rewrites them into the correct FIC grant flow.

## Diagnostic Checklist

| Check | Expected |
|-------|----------|
| `AddAgentIdentities()` called in DI setup | Yes |
| `AzureAd` config has blueprint's `ClientId` + `ClientSecret` | Yes |
| `WithAgentUserIdentity()` receives the agent app ID + user OID | Yes |
| `Microsoft.Identity.Web.AgentIdentities` NuGet package referenced | Yes |

## References

- `Microsoft.Identity.Web.AgentIdentities` source: [`AgentIdentitiesExtension.cs`](https://github.com/AzureAD/microsoft-identity-web/blob/main/src/Microsoft.Identity.Web.AgentIdentities/AgentIdentitiesExtension.cs)
- FIC grant handler: [`AgentUserIdentityMsalAddIn.cs`](https://github.com/AzureAD/microsoft-identity-web/blob/main/src/Microsoft.Identity.Web.AgentIdentities/AgentUserIdentityMsalAddIn.cs)
- Entra error reference: [AADSTS7000215](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes#aadsts-error-codes) — "The client secret provided is invalid" (misleading when the real issue is a client ID/secret mismatch)
