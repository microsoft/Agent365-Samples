# WNS Integration for SemanticKernelSampleAgent

This document describes the Windows Push Notification Service (WNS) integration added to the SemanticKernelSampleAgent project.

## Overview

The WNS integration allows remote Windows clients (running `locaproto.exe`) to register for push notifications and establish MCP (Model Context Protocol) connections with this agent service. This enables on-demand activation of local machine tools from your Azure-hosted agent.

## New Features

### 1. **WNS Client Registration**
Clients can register their WNS channel URIs with the agent service.

**Endpoint**: `POST /api/wns/channels/register`

**Request Body**:
```json
{
  "clientName": "MyComputer",
  "channelUri": "https://...",
  "machineName": "DESKTOP-123",
  "registeredAt": "2024-01-15T10:30:00Z"
}
```

###2. **List Registered Clients**
View all registered WNS clients.

**Endpoint**: `GET /api/wns/channels`

**Response**:
```json
[
  {
    "clientName": "MyComputer",
    "machineName": "DESKTOP-123",
    "channelUri": "https://...",
    "registeredAt": "2024-01-15T10:30:00Z",
    "lastSeen": "2024-01-15T11:00:00Z"
  }
]
```

### 3. **Send Push Notification**
Trigger a WNS push notification to wake up a client and establish an MCP connection.

**Endpoint**: `POST /api/wns/notify/{clientName}`

**Response**:
```json
{
  "message": "Notification sent",
  "sessionId": "abc-123-def",
  "callbackUrl": "wss://your-agent.azurewebsites.net/ws/mcp/abc-123-def"
}
```

### 4. **MCP WebSocket Endpoint**
Accepts WebSocket connections from locaproto clients for MCP communication.

**Endpoint**: `WebSocket /ws/mcp/{sessionId}`

### 5. **MCP Proxy Endpoint**
Allows HTTP clients to send MCP requests to connected locaproto instances.

**Endpoint**: `POST /api/wns/mcp/{sessionId}`

**Request Body**: JSON-RPC 2.0 request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### 6. **Session Management**
- **Status Check**: `GET /api/wns/status/{sessionId}` - Check if a session is active
- **Heartbeat**: `POST /api/wns/heartbeat/{sessionId}` - Keep session alive

## Configuration

Add the following to your `appsettings.json` or Azure App Service Configuration:

```json
{
  "WnsConfiguration": {
    "TenantId": "your-azure-ad-tenant-id",
    "ClientId": "your-azure-ad-application-id",
    "ClientSecret": "your-azure-ad-client-secret"
  },
  "SessionTimeouts": {
    "IdleTimeoutSeconds": 30,
    "PendingSessionTimeoutMinutes": 5
  }
}
```

**For production**: Store the `ClientSecret` in Azure Key Vault and retrieve it using Managed Identity.

## Azure AD App Registration

To use WNS, you need an Azure AD App Registration:

1. Go to Azure Portal ? Azure Active Directory ? App Registrations
2. Create a new registration (multi-tenant for Windows App SDK push notifications)
3. Record the **Application (client) ID** ? use as `ClientId`
4. Record the **Directory (tenant) ID** ? use as `TenantId`
5. Create a **Client Secret** under "Certificates & secrets" ? use as `ClientSecret`

## How It Works

### Flow Diagram

```
???????????????????         ????????????????         ???????????????????
?   locaproto     ?         ?  WNS Service ?         ?  Your Agent     ?
?   (Windows)     ?         ?  (Microsoft) ?         ?  (Azure)        ?
???????????????????         ????????????????         ???????????????????
         ?                         ?                          ?
         ?  1. Register Channel    ?                          ?
         ?????????????????????????????????????????????????????>?
         ?                         ?                          ?
         ?                         ?  2. Send Notification    ?
         ?                         ?<??????????????????????????
         ?                         ?                          ?
         ?  3. Deliver Notification?                          ?
         ?<?????????????????????????                          ?
         ?                         ?                          ?
         ?  4. WebSocket Connect                              ?
         ???????????????????????????????????????????????????>?
         ?                         ?                          ?
         ?  5. MCP Communication (tools/list, tools/call)    ?
         ?<?????????????????????????????????????????????????>?
         ?                         ?                          ?
```

### Step-by-Step

1. **Client Registration**: User runs `locaproto.exe --wns` which registers with WNS and sends its Channel URI to your agent
2. **Notification Request**: Your agent (or another service) calls `POST /api/wns/notify/{clientName}`
3. **WNS Delivery**: Your agent sends a WNS notification with a WebSocket callback URL
4. **Client Activation**: Windows delivers the notification to locaproto, which connects via WebSocket
5. **MCP Session**: Your agent can now invoke MCP tools on the client (e.g., get local time, system info, etc.)

## Security Considerations

- All WNS endpoints use `.AllowAnonymous()` for simplicity. **In production**, add authentication:
  ```csharp
  .RequireAuthorization() // Add this to secure endpoints
  ```
- WNS Channel URIs are sensitive - treat them as bearer tokens
- Use HTTPS/WSS in production
- Store secrets in Azure Key Vault
- Implement rate limiting for notification endpoints

## Compatibility with Existing Agent

? **No Breaking Changes**: The existing `/api/messages` endpoint for Bot Framework communication is unchanged.

The WNS endpoints are completely separate and optional:
- Original endpoint: `/api/messages` (unchanged)
- New WNS endpoints: `/api/wns/*` (additive)

## Testing

### 1. Test Client Registration
```bash
curl -X POST https://your-agent.azurewebsites.net/api/wns/channels/register \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "TestClient",
    "channelUri": "https://test.notify.windows.com/...",
    "machineName": "TEST-PC",
    "registeredAt": "2024-01-15T10:00:00Z"
  }'
```

### 2. Test List Clients
```bash
curl https://your-agent.azurewebsites.net/api/wns/channels
```

### 3. Test with locaproto
```bash
# Update locaproto SERVER_URL to point to your agent
locaproto.exe --wns

# Then from another machine or browser, call:
curl -X POST https://your-agent.azurewebsites.net/api/wns/notify/TestClient
```

## Files Added

- `Models/ClientRegistration.cs` - WNS client registration models
- `Models/McpSession.cs` - MCP session tracking
- `Services/WnsService.cs` - WNS notification sending service
- `WNS_README.md` - This file

## Files Modified

- `Program.cs` - Added WNS endpoints and WebSocket support
- `appsettings.json` - Added WNS configuration section

## Troubleshooting

### Issue: "WnsConfiguration not found"
**Solution**: Add WNS configuration to `appsettings.json` or set it as empty strings if not using WNS features.

### Issue: "Failed to acquire access token"
**Solution**: Verify Azure AD credentials are correct and the app has proper permissions.

### Issue: "Notification sent but client doesn't connect"
**Possible causes**:
- WNS channel URI expired (30-day lifetime)
- Client not running or not in WNS mode
- Firewall blocking WebSocket connections
- Client denied the connection in the confirmation dialog

### Issue: "Session timeout"
**Solution**: Adjust `SessionTimeouts:IdleTimeoutSeconds` in configuration or ensure client sends heartbeats.

## Next Steps

1. **Deploy to Azure**: Publish your agent to Azure App Service
2. **Configure WNS**: Set up Azure AD app registration and update configuration
3. **Update locaproto**: Point `SERVER_URL` to your agent's URL
4. **Test End-to-End**: Run `locaproto.exe --wns` and trigger notifications

## Support

For issues related to:
- **WNS Integration**: Check logs in Azure App Service ? Log stream
- **locaproto**: Check console output when running in WNS mode
- **MCP Protocol**: Verify JSON-RPC message format and tool definitions
