# Agent365 MCP Service — HTTP Error Report

**Date:** 2026-05-19
**Reporter:** Work IQ Teams Bot sample
**Trace URL:** `https://localhost:17248/traces/detail/0f80ae6e014dca157f355a78d1fa244f`

## Summary

Two MCP server endpoints return unexpected HTTP errors during normal
Streamable HTTP transport lifecycle operations. The errors are raised by
the server, not the client SDK.

## Issue 1 — GET returns 405 Method Not Allowed

| Field | Value |
|-------|-------|
| **Endpoint** | `GET https://agent365.svc.cloud.microsoft/agents/servers/mcp_MailTools` |
| **Status** | `405 Method Not Allowed` |
| **Phase** | SSE listener setup (post-initialize) |

### Details

The MCP C# SDK (`ModelContextProtocol.Client`) sends a `GET` request to
open a Server-Sent Events stream for server-initiated notifications after
the `initialize` handshake completes. The `mcp_MailTools` server rejects
this with **405**.

Per the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http),
`GET` is optional — servers that do not support server-initiated messages
may omit it. However, the expected response for an unsupported method is
still a well-formed HTTP error; the 405 is technically correct but creates
noise in traces because the client SDK does not suppress it.

### Suggested fix

Either:
- Return **501 Not Implemented** (clearer intent) and/or include an
  `Allow: POST` header so the SDK can avoid retries, or
- Support the `GET` SSE endpoint (no-op keep-alive stream is fine).

## Issue 2 — DELETE returns 500 Internal Server Error

| Field | Value |
|-------|-------|
| **Endpoint** | `DELETE https://agent365.svc.cloud.microsoft/agents/servers/mcp_TeamsServer` |
| **Status** | `500 Internal Server Error` |
| **Phase** | Session teardown (`McpClient.DisposeAsync`) |

### Details

When the MCP client disposes, it sends a `DELETE` to terminate the session
as required by the Streamable HTTP transport. The `mcp_TeamsServer` returns
a **500** instead of the expected **200 / 204**.

This is a server-side bug. The client already swallows disposal exceptions
so it does not affect end-user functionality, but it produces a failed span
on every conversation turn.

### Suggested fix

Fix the `DELETE` handler in `mcp_TeamsServer` to return **204 No Content**
on successful session teardown, or **404** if the session has already
expired.

## Client-side mitigation

An OpenTelemetry trace filter has been added to the sample to suppress
these known-noisy spans so they do not clutter Aspire dashboards while the
server-side fixes are pending. See `WorkIQAgent.ServiceExtensions.cs`.
