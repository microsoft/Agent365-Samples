# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from __future__ import annotations

import json
import logging
import random
from typing import Any, Callable, Optional

import httpx

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)

from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)


# ---------------------------------------------------------------------------
# Lightweight MCP JSON-RPC client (uses httpx — no extra dependencies)
# ---------------------------------------------------------------------------

class _McpSession:
    """Minimal MCP client that speaks JSON-RPC over Streamable HTTP."""

    def __init__(self, url: str, auth_token: str, server_name: str, logger: logging.Logger):
        self._url = url
        self._server_name = server_name
        self._auth_token = auth_token
        self._session_id: str | None = None
        self._req_id = 0
        self._http = httpx.AsyncClient(timeout=10.0)
        self._log = logger

    # -- public API ----------------------------------------------------------

    async def initialize(self) -> dict:
        result = await self._rpc("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "perplexity-agent", "version": "0.1.0"},
        })
        # Notify the server that the client is ready (fire-and-forget).
        await self._notify("notifications/initialized")
        return result

    async def list_tools(self) -> list[dict]:
        result = await self._rpc("tools/list", {})
        return result.get("tools", [])

    async def call_tool(self, name: str, arguments: dict) -> str:
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content", [])
        texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        return "\n".join(texts) if texts else json.dumps(result)

    async def close(self) -> None:
        await self._http.aclose()

    # -- transport -----------------------------------------------------------

    async def _rpc(self, method: str, params: dict) -> dict:
        self._req_id += 1
        body = {"jsonrpc": "2.0", "id": self._req_id, "method": method, "params": params}
        resp = await self._http.post(self._url, json=body, headers=self._headers())
        resp.raise_for_status()
        if "mcp-session-id" in resp.headers:
            self._session_id = resp.headers["mcp-session-id"]
        return self._parse(resp)

    async def _notify(self, method: str, params: dict | None = None) -> None:
        body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        try:
            await self._http.post(self._url, json=body, headers=self._headers())
        except Exception:
            pass  # notifications are best-effort

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self._auth_token}",
        }
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    def _parse(self, resp: httpx.Response) -> dict:
        ct = resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            return self._parse_sse(resp.text)
        data = resp.json()
        if "error" in data:
            raise RuntimeError(f"MCP error from '{self._server_name}': {data['error']}")
        return data.get("result", {})

    @staticmethod
    def _parse_sse(text: str) -> dict:
        for line in text.split("\n"):
            if line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                    if "result" in data:
                        return data["result"]
                except json.JSONDecodeError:
                    continue
        return {}


# ---------------------------------------------------------------------------
# Public service
# ---------------------------------------------------------------------------

# Type aliases for the tuple returned by get_mcp_tools.
ToolExecutor = Callable[[str, dict], Any]   # async (name, args) -> str

# Retry configuration (follows CrewAI exponential-backoff pattern)
_MCP_MAX_RETRIES = 2
_MCP_RETRY_BASE_DELAY_SECONDS = 1  # base_delay * 2^attempt + jitter


class McpToolRegistrationService:
    """Discover MCP servers, connect via JSON-RPC, and return callable tools.

    Returns OpenAI-compatible tool definitions so the Perplexity client can use
    function calling.  Also provides an *execute_tool* callback.

    MCP sessions and tool definitions are cached across turns so subsequent
    messages reuse existing connections instead of reconnecting every time.
    """

    def __init__(self, logger: Optional[logging.Logger] = None):
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self.config_service = McpToolServerConfigurationService(logger=self._logger)
        # Cached state — survives across turns
        self._sessions: list[_McpSession] = []
        self._tool_map: dict[str, _McpSession] = {}   # tool_name -> session
        self._openai_tools: list[dict] = []
        self._initialized = False

    @staticmethod
    def _sanitize_schema(raw: Any) -> dict:
        """Ensure an MCP inputSchema is a valid Perplexity function-parameters object.

        Perplexity is stricter than OpenAI about tool schemas.  Known issues:
        - ``"required": []`` (empty array) — causes "Tool parameters must be a
          JSON object" error.  Must be removed entirely.
        - ``$defs`` / ``$ref`` / ``additionalProperties`` — unsupported.
        - ``null`` / missing schemas — need a default.
        """
        empty: dict = {"type": "object", "properties": {}}

        if not isinstance(raw, dict):
            return empty

        # Force top-level type to "object"
        if raw.get("type") != "object":
            return empty

        # Keys Perplexity doesn't understand
        _UNSUPPORTED_KEYS = {
            "$defs", "$ref", "additionalProperties", "allOf", "anyOf",
            "oneOf", "not", "$schema", "definitions",
        }

        def _clean(schema: dict) -> dict:
            """Recursively remove unsupported keys and fix empty required arrays."""
            cleaned: dict = {}
            for k, v in schema.items():
                if k in _UNSUPPORTED_KEYS:
                    continue
                # Remove empty "required" arrays — Perplexity rejects them
                if k == "required" and isinstance(v, list) and len(v) == 0:
                    continue
                cleaned[k] = v

            # Clean nested properties
            if "properties" in cleaned and isinstance(cleaned["properties"], dict):
                for prop_name, prop_val in list(cleaned["properties"].items()):
                    if isinstance(prop_val, dict):
                        cleaned["properties"][prop_name] = _clean(prop_val)
                    else:
                        del cleaned["properties"][prop_name]

            # Clean items (for array types)
            if "items" in cleaned and isinstance(cleaned["items"], dict):
                cleaned["items"] = _clean(cleaned["items"])

            return cleaned

        result = _clean(raw)
        # Guarantee "properties" exists
        if "properties" not in result:
            result["properties"] = {}
        return result

    async def get_mcp_tools(
        self,
        agentic_app_id: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> tuple[list[dict], ToolExecutor]:
        """
        Connect to every MCP server and return OpenAI tool definitions.

        Subsequent calls return cached sessions/tools unless a reconnect
        is triggered by a prior failure.

        Returns:
            (openai_tools, execute_tool)
        """
        if self._initialized and self._openai_tools:
            self._logger.info(
                "Returning %d cached MCP tools from %d sessions",
                len(self._openai_tools),
                len(self._sessions),
            )
            return self._openai_tools, self._make_executor()

        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            auth_token_obj = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_token_obj.token

        self._logger.info("Listing MCP tool servers for agent %s", agentic_app_id)
        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token,
        )
        self._logger.info("Loaded %d MCP server configurations", len(mcp_server_configs))

        # Connect to all MCP servers in parallel for faster startup.
        import asyncio as _asyncio

        async def _connect_server(server_config):
            """Initialize one MCP server and return (session, tools) or None."""
            # Extract URL — the SDK sometimes stores it in .url, sometimes
            # in .mcp_server_unique_name (when .url is omitted from __dict__).
            raw_url = getattr(server_config, "url", None)
            raw_unique = getattr(server_config, "mcp_server_unique_name", None) or ""
            raw_name = getattr(server_config, "mcp_server_name", None) or ""

            if raw_url:
                server_url = raw_url
            elif raw_unique.startswith("http"):
                server_url = raw_unique
            else:
                server_url = None

            # Prefer mcp_server_name as the human-readable name; fall back
            server_name = raw_name or (raw_unique if not raw_unique.startswith("http") else "unknown")

            self._logger.info(
                "MCP server '%s' -> %s",
                server_name,
                server_url or "(no URL)",
            )
            if not server_url:
                self._logger.warning(
                    "Skipping MCP server '%s' — no URL configured.",
                    server_name,
                )
                return None
            try:
                session = _McpSession(
                    url=server_url,
                    auth_token=auth_token,
                    server_name=server_name,
                    logger=self._logger,
                )
                await session.initialize()
                tools = await session.list_tools()
                self._logger.info(
                    "Server '%s' exposes %d tools",
                    server_name,
                    len(tools),
                )
                return session, tools
            except Exception as exc:
                self._logger.warning(
                    "Failed to connect to MCP server '%s' at %s: %s",
                    server_name,
                    server_url,
                    exc,
                )
                try:
                    await session.close()
                except Exception:
                    pass
                return None

        results = await _asyncio.gather(
            *[_connect_server(cfg) for cfg in mcp_server_configs],
            return_exceptions=True,
        )

        for idx, result in enumerate(results):
            if isinstance(result, BaseException):
                self._logger.error(
                    "MCP server %d raised unexpected error: %s: %s",
                    idx, type(result).__name__, result,
                )
                continue
            if result is None:
                continue
            session, tools = result
            self._sessions.append(session)
            for tool in tools:
                name = tool.get("name", "")
                if not name:
                    continue
                # Sanitize inputSchema — Perplexity requires parameters
                # to be a JSON Schema object with "type": "object".
                raw_schema = tool.get("inputSchema")
                params = self._sanitize_schema(raw_schema)
                self._logger.debug("Tool '%s' parameters: %s", name, json.dumps(params))
                # Log tools whose names suggest sending/creating — helps debug empty-arg issues
                if any(kw in name.lower() for kw in ("send", "create", "schedule", "forward", "reply")):
                    self._logger.info("Tool '%s' schema: %s", name, json.dumps(params, indent=2))
                # Responses API format: flat structure (name at top level)
                self._openai_tools.append({
                    "type": "function",
                    "name": name,
                    "description": tool.get("description", ""),
                    "parameters": params,
                })
                self._tool_map[name] = session

        if not self._openai_tools:
            self._logger.info("No MCP tools discovered — running without tools")
        else:
            self._logger.info("Registered %d MCP tools from %d servers", len(self._openai_tools), len(self._sessions))

        self._initialized = True
        return self._openai_tools, self._make_executor()

    def _make_executor(self) -> ToolExecutor:
        """Return an async callback that dispatches tool calls to the right MCP session.

        Includes retry with exponential backoff + jitter on transient errors
        (follows the CrewAI sample pattern).
        """
        tool_map = self._tool_map
        svc = self  # capture for cache-invalidation on persistent failures

        async def execute_tool(name: str, arguments: dict) -> str:
            session = tool_map.get(name)
            if not session:
                return f"Error: unknown tool '{name}'"

            import asyncio as _aio

            last_error: Exception | None = None
            for attempt in range(_MCP_MAX_RETRIES + 1):
                try:
                    return await session.call_tool(name, arguments)
                except httpx.TimeoutException as exc:
                    last_error = exc
                    svc._logger.warning(
                        "Timeout on attempt %d/%d for tool '%s'",
                        attempt + 1, _MCP_MAX_RETRIES + 1, name,
                    )
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code in (502, 503, 504):
                        last_error = exc
                        svc._logger.warning(
                            "Retryable %d on attempt %d/%d for tool '%s'",
                            exc.response.status_code,
                            attempt + 1, _MCP_MAX_RETRIES + 1, name,
                        )
                    else:
                        svc._logger.error("Tool call '%s' failed: %s", name, exc)
                        return f"Error executing tool '{name}': {exc}"
                except (ConnectionError, OSError) as exc:
                    last_error = exc
                    svc._logger.warning(
                        "Connection error on attempt %d/%d for tool '%s': %s",
                        attempt + 1, _MCP_MAX_RETRIES + 1, name, exc,
                    )
                except Exception as exc:
                    svc._logger.error("Tool call '%s' failed: %s", name, exc)
                    return f"Error executing tool '{name}': {exc}"

                # Exponential backoff + jitter (except on last attempt)
                if attempt < _MCP_MAX_RETRIES:
                    delay = _MCP_RETRY_BASE_DELAY_SECONDS * (2 ** attempt) + random.uniform(0, 0.5)
                    svc._logger.info("Retrying tool '%s' in %.2fs…", name, delay)
                    await _aio.sleep(delay)

            # All retries exhausted — invalidate cache so next turn reconnects
            svc._logger.error(
                "Tool '%s' failed after %d attempts — clearing MCP cache",
                name, _MCP_MAX_RETRIES + 1,
            )
            await svc._invalidate_cache()
            return f"Error executing tool '{name}': {last_error}"

        return execute_tool

    async def _invalidate_cache(self) -> None:
        """Close existing MCP sessions and clear all cached state.

        Called when retries are exhausted so the next turn reconnects
        from scratch instead of appending duplicates.
        """
        for s in self._sessions:
            try:
                await s.close()
            except Exception:
                pass
        self._sessions.clear()
        self._tool_map.clear()
        self._openai_tools.clear()
        self._initialized = False

    async def close(self) -> None:
        """Close all cached MCP sessions (call on server shutdown)."""
        await self._invalidate_cache()
