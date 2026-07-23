# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Perplexity Client
Wraps the OpenAI Python client pointed at the Perplexity Agent API.
Uses the Responses API format (``/v1/responses``) which supports function
calling (tool use) with custom tools and Perplexity built-in tools.
"""

import asyncio
import json
import logging
import re
import time
from typing import Any, Callable

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# Agent API requires the /v1 base URL (maps to /v1/responses via the SDK)
_PERPLEXITY_BASE_URL = "https://api.perplexity.ai/v1"

# Maximum number of tool-call rounds before forcing a final summary.
_MAX_TOOL_ROUNDS = 8

# Wall-clock limit (seconds) for the entire invoke() call including all rounds.
_MAX_TOTAL_SECONDS = 90

# Timeout (seconds) for a single Perplexity API call.
_PER_ROUND_TIMEOUT = 30

# Tool-selection threshold: when more tools than this are available,
# make a fast preliminary call to pick only the relevant ones.
_TOOL_SELECTION_THRESHOLD = 20

# Maximum tools the selector may return.
_TOOL_SELECTION_MAX = 15

# Timeout (seconds) for the tool-selection call.
_TOOL_SELECTION_TIMEOUT = 15


async def select_relevant_tools(
    client: AsyncOpenAI,
    model: str,
    user_message: str,
    all_tools: list[dict],
) -> list[dict]:
    """Use a fast LLM call to pick only the tools relevant to *user_message*.

    Returns a filtered subset (≤ ``_TOOL_SELECTION_MAX``) of *all_tools*.
    On any failure the full list is returned so the main flow is never blocked.
    """
    # Build a compact one-line-per-tool catalog for the selector prompt.
    catalog_lines: list[str] = []
    for idx, t in enumerate(all_tools):
        name = t.get("name", "unknown")
        desc = (t.get("description") or "")[:120]
        catalog_lines.append(f"{idx}: {name} — {desc}")
    catalog = "\n".join(catalog_lines)

    selector_prompt = (
        "Given the user's request, select ONLY the tools needed to fulfill it.\n"
        "Return a JSON array of tool index numbers (integers). Include tools that "
        "might be needed for follow-up steps (e.g., if creating a document and sharing "
        "a link, include both create and share tools).\n"
        f"Select at most {_TOOL_SELECTION_MAX} tools. Return ONLY a JSON array like "
        "[0, 3, 7], no explanation.\n\n"
        f'User request: "{user_message}"\n\n'
        f"Available tools:\n{catalog}"
    )

    try:
        resp = await asyncio.wait_for(
            client.responses.create(
                model=model,
                instructions="You are a tool selector. Return ONLY a JSON array of integers.",
                input=selector_prompt,
                store=False,
            ),
            timeout=_TOOL_SELECTION_TIMEOUT,
        )

        raw_text = ""
        for item in resp.output:
            if item.type == "message":
                for c in getattr(item, "content", []):
                    if hasattr(c, "text") and c.text:
                        raw_text += c.text
        if not raw_text:
            raw_text = str(resp.output_text or "")

        # Strip markdown fences and extract the JSON array.
        raw_text = raw_text.strip().strip("`").strip()
        if raw_text.startswith("json"):
            raw_text = raw_text[4:].strip()

        match = re.search(r"\[[\d,\s]+\]", raw_text)
        if not match:
            logger.warning("Tool selector returned unparseable response — using all tools")
            return all_tools

        indices: list[int] = json.loads(match.group())
        selected = [all_tools[i] for i in indices if 0 <= i < len(all_tools)]

        if not selected:
            logger.warning("Tool selector returned empty set — using all tools")
            return all_tools

        logger.info(
            "Tool selector narrowed %d → %d tools: %s",
            len(all_tools),
            len(selected),
            [t.get("name") for t in selected],
        )
        return selected

    except asyncio.TimeoutError:
        logger.warning("Tool selector timed out (%ds) — using all tools", _TOOL_SELECTION_TIMEOUT)
        return all_tools
    except Exception as exc:
        logger.warning("Tool selector failed (%s) — using all tools", exc)
        return all_tools


class PerplexityClient:
    """Async client for Perplexity AI using the Agent API (Responses API)."""

    def __init__(self, api_key: str, model: str = "perplexity/sonar", system_prompt: str = ""):
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=_PERPLEXITY_BASE_URL,
        )
        self.model = model
        self.system_prompt = system_prompt

    async def close(self) -> None:
        """Close the underlying HTTP client to free resources."""
        try:
            await self._client.close()
        except Exception:
            pass

    async def invoke(
        self,
        user_message: str,
        tools: list[dict] | None = None,
        tool_executor: Callable | None = None,
    ) -> str:
        """
        Send a user message to Perplexity and return the response.

        When *tools* (Responses-API format) and a *tool_executor* callback are
        provided, the client runs a multi-turn tool-call loop automatically.
        Falls back to plain text (with tool descriptions embedded in the
        prompt) if the model rejects the ``tools`` parameter.
        """
        logger.info("Invoking Perplexity model=%s (tools=%d)", self.model, len(tools or []))

        # When too many tools are registered, use a fast selector call to
        # narrow down to just the relevant ones before the main API request.
        if tools and len(tools) > _TOOL_SELECTION_THRESHOLD:
            tools = await select_relevant_tools(self._client, self.model, user_message, tools)

        create_kwargs: dict[str, Any] = {
            "model": self.model,
            "input": user_message,
            "instructions": self.system_prompt,
        }
        if tools:
            create_kwargs["tools"] = tools

        invoke_start = time.monotonic()
        last_text: str = ""  # best partial answer seen so far
        _pending_resource_id: str | None = None  # ID of a created-but-not-finalized resource
        _pending_resource_type: str | None = None  # e.g. "draft", "event" — inferred from tool name
        _resource_finalized: bool = False  # True once a send/submit/finalize tool was called
        _retried_with_nudge: bool = False  # prevent infinite re-prompt loop
        _send_tool_name: str | None = None  # discovered send tool name from schema

        for _round in range(_MAX_TOOL_ROUNDS):
            elapsed = time.monotonic() - invoke_start
            if elapsed > _MAX_TOTAL_SECONDS:
                logger.warning("Wall-clock limit (%.0fs) hit after %d rounds", elapsed, _round)
                break

            try:
                t0 = time.monotonic()
                response = await asyncio.wait_for(
                    self._client.responses.create(**create_kwargs),
                    timeout=_PER_ROUND_TIMEOUT,
                )
                logger.info("Perplexity API round %d took %.1fs (total %.1fs)", _round + 1, time.monotonic() - t0, time.monotonic() - invoke_start)
            except asyncio.TimeoutError:
                logger.warning("Perplexity API round %d timed out (%ds) — returning partial answer", _round + 1, _PER_ROUND_TIMEOUT)
                break
            except Exception as api_err:
                err_text = str(api_err).lower()
                if tools and any(kw in err_text for kw in ("not supported", "unrecognized", "tool", "parameter", "function")):
                    logger.warning("Tool-call API error — falling back to text-only: %s", api_err)
                    create_kwargs.pop("tools", None)
                    ctx = self._tools_as_context(tools)
                    if ctx:
                        create_kwargs["input"] = f"{user_message}\n\n{ctx}"
                    tools = None
                    try:
                        response = await asyncio.wait_for(
                            self._client.responses.create(**create_kwargs),
                            timeout=_PER_ROUND_TIMEOUT,
                        )
                    except asyncio.TimeoutError:
                        logger.warning("Perplexity API fallback round %d timed out (%ds) — returning partial answer", _round + 1, _PER_ROUND_TIMEOUT)
                        break
                else:
                    raise

            # Collect function calls and text from the output items
            function_calls = []
            text_parts: list[str] = []
            for item in response.output:
                if item.type == "function_call":
                    function_calls.append(item)
                elif item.type == "message":
                    for c in getattr(item, "content", []):
                        if hasattr(c, "text") and c.text:
                            text_parts.append(c.text)

            # Track the best partial answer
            if text_parts:
                last_text = "\n".join(text_parts)

            # No function calls → final text response
            if not function_calls or not tool_executor:
                # --- Re-prompt: model returned text without calling tools on round 1 ---
                # Perplexity Sonar often describes what it WOULD do instead of doing it.
                # If tools are available and user wants an action, force a retry.
                if (
                    _round == 0
                    and tools
                    and tool_executor
                    and not _retried_with_nudge
                    and self._user_wants_action(user_message)
                ):
                    _retried_with_nudge = True
                    nudge = (
                        "Do NOT describe what you would do. You MUST call the appropriate tool "
                        "right now to complete the user's request. Use the tools provided."
                    )
                    create_kwargs["input"] = f"{user_message}\n\n[SYSTEM: {nudge}]"
                    logger.info("Model returned text without tool calls — re-prompting with nudge")
                    continue

                # Auto-finalize: if a resource was created but never sent/submitted
                if (
                    _pending_resource_id
                    and not _resource_finalized
                    and tool_executor
                    and self._user_wants_to_send(user_message)
                ):
                    # Find a send/submit tool from the schema that takes an ID param
                    send_tool = _send_tool_name or self._find_finalize_tool(tools or [])
                    if send_tool:
                        logger.info("Auto-finalizing resource via '%s' (model stopped short)", send_tool)
                        try:
                            # Determine the ID parameter name from the tool schema
                            id_param = self._find_id_param(send_tool, tools or [])
                            send_result = await tool_executor(send_tool, {id_param: _pending_resource_id})
                            logger.info("Auto-finalize result: %.300s", str(send_result))
                            _resource_finalized = True
                            answer = last_text or str(response.output_text or response)
                            if "draft" in answer.lower() or "would you like" in answer.lower():
                                answer = f"Done — your request has been completed. {answer.split(chr(10))[0]}"
                        except Exception as send_err:
                            logger.warning("Auto-finalize failed: %s", send_err)
                answer = last_text or str(response.output_text or response)
                return answer

            # ---- Tool-call round ------------------------------------------------
            # Build follow-up input: previous output + function results
            next_input = [item.model_dump() for item in response.output]

            for fc in function_calls:
                try:
                    arguments = json.loads(fc.arguments)
                except (json.JSONDecodeError, TypeError):
                    arguments = {}

                # Enrich empty content fields from the user's original message
                arguments = self._enrich_arguments(fc.name, arguments, user_message, tools or [])

                logger.info("Executing MCP tool: %s (round %d)", fc.name, _round + 1)
                logger.debug("Tool arguments: %s", json.dumps(arguments, indent=2, default=str))
                result = await tool_executor(fc.name, arguments)
                logger.debug("Tool result (first 500 chars): %.500s", json.dumps(result, default=str) if not isinstance(result, str) else result)

                # Track resource creation/finalization generically
                tool_lower = fc.name.lower()
                # Detect "create" tools — track the resource ID for auto-finalize
                if re.search(r'create|new|add|book|schedule', tool_lower):
                    try:
                        r = json.loads(result) if isinstance(result, str) else result
                        # Look for any ID-like field in the response
                        resource_id = self._extract_resource_id(r)
                        if resource_id:
                            _pending_resource_id = resource_id
                            _pending_resource_type = tool_lower
                            logger.info("Tracked created resource: %s (from %s)", resource_id[:40], fc.name)
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        pass
                # Detect "send/submit/finalize" tools
                if re.search(r'send|submit|publish|finalize|confirm|dispatch', tool_lower):
                    _resource_finalized = True
                    _send_tool_name = fc.name

                next_input.append({
                    "type": "function_call_output",
                    "call_id": fc.call_id,
                    "output": json.dumps(result) if not isinstance(result, str) else result,
                })

            # Send function results back for the next round
            create_kwargs["input"] = next_input

        # Exhausted rounds or hit wall-clock/per-round timeout.
        # Do one final API call WITHOUT tools so the model can summarize
        # what it accomplished (the tool results are still in create_kwargs["input"]).
        try:
            create_kwargs.pop("tools", None)
            logger.info("Max rounds/time reached — making final summary call")
            summary = await asyncio.wait_for(
                self._client.responses.create(**create_kwargs),
                timeout=_PER_ROUND_TIMEOUT,
            )
            for item in summary.output:
                if item.type == "message":
                    for c in getattr(item, "content", []):
                        if hasattr(c, "text") and c.text:
                            return c.text
            if summary.output_text:
                return summary.output_text
        except Exception as summary_err:
            logger.warning("Final summary call failed: %s", summary_err)

        if last_text:
            return last_text
        return "I ran out of time processing your request. The actions may have partially completed — please check and try again if needed."

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _enrich_arguments(
        tool_name: str,
        arguments: dict,
        user_message: str,
        tools: list[dict],
    ) -> dict:
        """
        Safety net: fill content fields the model left empty by inspecting
        tool schemas for content-like properties and extracting from the
        user message.  Works generically — not hardcoded to any specific tool.
        """
        # Find the schema for this tool
        schema = None
        for t in tools:
            if t.get("name") == tool_name:
                schema = t.get("parameters", {})
                break
        if not schema:
            return arguments

        props = schema.get("properties", {})

        # Extract the user's intended content from their message
        content = PerplexityClient._extract_content(user_message)
        if not content:
            return arguments

        # Keywords that signal a field is meant to hold user-authored content
        _SUBJECT_HINTS = {"subject", "title"}
        _BODY_HINTS = {"body", "comment"}

        patched = False
        for field_name, field_def in props.items():
            if field_def.get("type") != "string":
                continue
            # Already filled by the model → leave it alone
            if arguments.get(field_name):
                continue

            field_lower = field_name.lower()
            desc = field_def.get("description", "")
            desc_lower = desc.lower()

            # Skip enum/format fields (e.g. "contentType: Text or HTML")
            if re.search(r":\s*\w+\s+or\s+\w+|'[^']+',?\s*'[^']+'", desc_lower):
                continue
            if any(kw in field_lower for kw in ("type", "format", "encoding", "provider", "mode")):
                continue

            if any(h in field_lower for h in _SUBJECT_HINTS):
                arguments[field_name] = content
                patched = True
            elif any(h in field_lower or h in desc_lower for h in _BODY_HINTS):
                arguments[field_name] = content
                patched = True

        if patched:
            logger.info("Enriched arguments for '%s' with content from user message", tool_name)
        return arguments

    @staticmethod
    def _extract_content(user_message: str) -> str:
        """Extract intended content from a user message (e.g. 'send mail saying X')."""
        # Ordered from most specific to least
        patterns = [
            r'(?:saying|say)\s+(.+?)(?:\s+and\s+send|\s+right\s+away|$)',
            r'(?:with\s+(?:message|body|text|content|subject))\s+(.+?)$',
            r'(?:that\s+says?)\s+(.+?)$',
            r'(?:about)\s+(.+?)$',
            r'(?:titled?)\s+(.+?)$',
        ]
        for pattern in patterns:
            match = re.search(pattern, user_message, re.IGNORECASE)
            if match:
                return match.group(match.lastindex).strip()
        return ""

    @staticmethod
    def _user_wants_to_send(user_message: str) -> bool:
        """Check if the user's message indicates they want to perform an action (not just draft/view)."""
        msg = user_message.lower()
        if re.search(r'\b(send|mail|email|schedule|create|book|invite|forward|reply)\b', msg) and not re.search(r'\bdraft\b', msg):
            return True
        return False

    @staticmethod
    def _user_wants_action(user_message: str) -> bool:
        """Check if the user's message implies an action that requires tool calls."""
        msg = user_message.lower()
        action_verbs = (
            r'\b(send|mail|email|schedule|create|book|set\s+up|arrange|'
            r'cancel|delete|remove|move|forward|reply|update|add|invite)\b'
        )
        return bool(re.search(action_verbs, msg))

    @staticmethod
    def _extract_resource_id(result: dict) -> str | None:
        """Extract a resource ID from a tool result, searching common response shapes."""
        # Check common patterns: {data: {messageId}}, {data: {id}}, {messageId}, {id}, {eventId}
        data = result.get("data", {}) or {}
        for key in ("messageId", "id", "eventId", "itemId", "draftId", "resourceId"):
            val = data.get(key) or result.get(key)
            if val and isinstance(val, str):
                return val
        return None

    @staticmethod
    def _find_finalize_tool(tools: list[dict]) -> str | None:
        """Find a send/submit/finalize tool from the schema list."""
        for t in tools:
            name = (t.get("name") or "").lower()
            if re.search(r'send.*draft|send.*message|submit|publish|dispatch', name):
                return t.get("name")
        return None

    @staticmethod
    def _find_id_param(tool_name: str, tools: list[dict]) -> str:
        """Find the ID parameter name for a tool from its schema."""
        for t in tools:
            if t.get("name") == tool_name:
                props = t.get("parameters", {}).get("properties", {})
                required = t.get("parameters", {}).get("required", [])
                # Prefer the required ID field
                for r in required:
                    if "id" in r.lower():
                        return r
                # Fall back to any property with "id" in its name
                for p in props:
                    if "id" in p.lower():
                        return p
        return "id"  # safe default

    @staticmethod
    def _tools_as_context(tools: list[dict]) -> str:
        """Format Responses-API tool definitions as a plain-text context block (fallback)."""
        lines = []
        for tool in tools:
            if tool.get("type") == "function":
                name = tool.get("name", "tool")
                desc = tool.get("description", "no description")
                lines.append(f"- {name}: {desc}")
        if not lines:
            return ""
        return (
            "[Available tools for context — these are MCP tools the system has access to:\n"
            + "\n".join(lines) + "]"
        )
