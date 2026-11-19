# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import base64
import asyncio
import builtins
import io
import json
import logging
import os
import subprocess
import sys
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from contextlib import redirect_stdout
from pathlib import Path

os.environ["ENABLE_A365_OBSERVABILITY_EXPORTER"] = "false"
os.environ["MICROSOFT_OTEL_SDKSTATS_DISABLED"] = "true"

import httpx

from agent import SemanticKernelAgent
from mcp_tool_registration_service import McpToolRegistrationService
from observability.app_token_resolver import AppTokenResolver
from turn_context_utils import extract_turn_context_details
from microsoft_agents.activity import Activity, ChannelAccount, ConversationAccount, RoleTypes
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from semantic_kernel import Kernel
from semantic_kernel.functions import kernel_function
from semantic_kernel.functions.kernel_arguments import KernelArguments


class StartupEncodingTests(unittest.TestCase):
    def test_exporter_transport_and_success_diagnostic_in_subprocess(self):
        script = """
import json, os, uuid
from unittest.mock import patch
import requests
os.environ.update(
    ENABLE_A365_OBSERVABILITY_EXPORTER="true",
    MICROSOFT_OTEL_SDKSTATS_DISABLED="true",
    A365_OBSERVABILITY_LOG_LEVEL="debug|info|warn|error",
)
payloads = []
def post(session, url, **kwargs):
    headers = {key.lower(): value for key, value in kwargs["headers"].items()}
    assert headers["authorization"] == "Bearer synthetic-token"
    payloads.append(json.loads(kwargs["data"]))
    response = requests.Response()
    response.status_code = 200
    response._content = b'{"results":[{"status":"sent"}],"partialSuccess":{"rejectedSpans":0}}'
    return response
with patch("requests.sessions.Session.post", post):
    import observability_config as config
    from microsoft.opentelemetry.a365.core import (
        AgentDetails, InvokeAgentScope, InvokeAgentScopeDetails, Request,
    )
    from opentelemetry import trace
    agent_id, tenant_id = str(uuid.uuid4()), str(uuid.uuid4())
    with patch.object(config.OBS_TOKENS, "_cached", return_value="synthetic-token"):
        with InvokeAgentScope.start(
            request=Request(content="synthetic prompt", conversation_id="synthetic-run"),
            scope_details=InvokeAgentScopeDetails(),
            agent_details=AgentDetails(
                agent_id=agent_id, tenant_id=tenant_id, agent_name="Semantic-Kernel"
            ),
        ) as scope:
            scope.record_output_messages(["synthetic response"])
        assert trace.get_tracer_provider().force_flush()
    assert len(payloads) == 1, len(payloads)
    span = payloads[0]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert span["attributes"]["gen_ai.agent.id"] == agent_id
    assert "synthetic prompt" in span["attributes"]["gen_ai.input.messages"]
    config.shutdown_observability()
print("MOCK_EXPORT_PASS")
"""
        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, check=False,
            encoding="utf-8", errors="replace", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MOCK_EXPORT_PASS", result.stdout)
        self.assertIn("HTTP 200 success", result.stderr)
        self.assertIn('"status":"sent"', result.stderr)

    def test_console_logging_preserves_existing_handlers_and_is_idempotent(self):
        from observability_config import configure_console_logging
        root = logging.getLogger()
        existing = list(root.handlers)
        configure_console_logging()
        configure_console_logging()
        self.assertTrue(all(handler in root.handlers for handler in existing))
        consoles = [h for h in root.handlers if h.name == "semantic-kernel-console"]
        self.assertEqual(len(consoles), 1)
        output = io.StringIO()
        with patch.object(consoles[0], "stream", output):
            logging.getLogger("agent").info("synthetic application diagnostic")
            logging.getLogger("microsoft.opentelemetry.a365").warning("synthetic exporter diagnostic")
        self.assertEqual(output.getvalue().count("synthetic application diagnostic"), 1)
        self.assertEqual(output.getvalue().count("synthetic exporter diagnostic"), 1)

    def test_redirected_cp1252_startup_and_error_output(self):
        entrypoint = Path(__file__).resolve().parents[1] / "start_with_generic_host.py"
        for fail in (False, True):
            with self.subTest(fail=fail):
                script = f"""
import runpy
import sys
from types import ModuleType
sys.stdout.reconfigure(encoding="cp1252", errors="strict")
sys.stderr.reconfigure(encoding="cp1252", errors="strict")
agent = ModuleType("agent")
agent.SemanticKernelAgent = type("SemanticKernelAgent", (), {{}})
host = ModuleType("host_agent_server")
def start(agent_class):
    if {fail!r}:
        raise RuntimeError("synthetic startup failure")
host.create_and_run_host = start
sys.modules["agent"] = agent
sys.modules["host_agent_server"] = host
runpy.run_path({str(entrypoint)!r}, run_name="__main__")
"""
                result = subprocess.run(
                    [sys.executable, "-c", script], capture_output=True, check=False
                )
                stdout = result.stdout.decode("utf-8")
                stderr = result.stderr.decode("utf-8")
                self.assertEqual(result.returncode, 1 if fail else 0, stderr)
                self.assertIn("\u2705 Starting Generic Agent Host", stdout)
                self.assertNotIn("UnicodeEncodeError", stderr)
                if fail:
                    self.assertIn("\u274c Failed to start server", stdout)
                    self.assertIn("RuntimeError: synthetic startup failure", stderr)


class HostingRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_pipeline_passes_context_to_next_handler(self):
        from host_agent_server import GenericAgentHost
        with patch.dict(os.environ, {"AUTH_HANDLER_NAME": ""}), redirect_stdout(io.StringIO()):
            host = GenericAgentHost(SemanticKernelAgent)
        for activity in (
            Activity(type="message", text="hello"),
            Activity(type="event", name="continueConversation"),
        ):
            with self.subTest(activity_type=activity.type):
                context = SimpleNamespace(activity=activity)
                handler = AsyncMock()
                await host.adapter.middleware_set.receive_activity_with_status(context, handler)
                handler.assert_awaited_once_with(context)


class McpRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_closes_kernel_clients_and_clears_history(self):
        agent = SemanticKernelAgent.__new__(SemanticKernelAgent)
        agent.mcp_service = SimpleNamespace(cleanup=AsyncMock())
        close = AsyncMock()
        agent.kernel = SimpleNamespace(
            services={"llm": SimpleNamespace(client=SimpleNamespace(close=close))}
        )
        agent._chat_histories = {"conversation": object()}

        await agent.cleanup()

        close.assert_awaited_once()
        self.assertEqual(agent._chat_histories, {})

    async def test_agentic_mcp_requires_auth_handler(self):
        agent = SemanticKernelAgent.__new__(SemanticKernelAgent)
        agent._mcp_tools_registered = False
        agent.mcp_service = SimpleNamespace(discover_servers=AsyncMock())
        with patch.dict(os.environ, {"USE_AGENTIC_AUTH": "true", "SKIP_TOOLING_ON_ERRORS": "false"}):
            with self.assertRaisesRegex(ValueError, "AUTH_HANDLER_NAME"):
                await agent.setup_mcp_tools(None, None, None)
        agent.mcp_service.discover_servers.assert_not_awaited()

    async def test_static_mcp_requires_bearer_token(self):
        agent = SemanticKernelAgent.__new__(SemanticKernelAgent)
        agent._mcp_tools_registered = False
        agent.auth_options = SimpleNamespace(bearer_token="")
        with patch.dict(os.environ, {"USE_AGENTIC_AUTH": "false", "SKIP_TOOLING_ON_ERRORS": "false"}):
            with self.assertRaisesRegex(ValueError, "BEARER_TOKEN"):
                await agent.setup_mcp_tools(None, None, None)

    async def test_failed_manual_registration_is_not_counted(self):
        service = McpToolRegistrationService.__new__(McpToolRegistrationService)
        service._logger = logging.getLogger("test")
        service._server_configs = [
            SimpleNamespace(mcp_server_name="test", url="https://example.invalid")
        ]
        service._register_mcp_tools_manually = AsyncMock(return_value=False)
        original_import = builtins.__import__

        def without_connector(name, *args, **kwargs):
            if name == "semantic_kernel.connectors.mcp":
                raise ImportError("Optional connector unavailable")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=without_connector):
            self.assertEqual(await service.add_tools_to_kernel(object()), 0)

    async def test_request_ids_are_unique_within_session(self):
        ids = []

        def respond(request):
            payload = json.loads(request.content)
            ids.append(payload["id"])
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": payload["id"], "result": {}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            for _ in range(3):
                await McpToolRegistrationService._send_mcp_request(
                    client, "https://example.invalid", "tools/call", {}, {"mcp-session-id": "session"}
                )
        self.assertEqual(len(set(ids)), 3)

    async def test_http_and_rpc_errors_are_not_empty_successes(self):
        for mode in ("http", "rpc", "wrong_id"):
            with self.subTest(mode=mode):
                def respond(request):
                    request_id = json.loads(request.content)["id"]
                    if mode == "http":
                        return httpx.Response(401, json={"error": "unauthorized"})
                    if mode == "rpc":
                        return httpx.Response(200, json={
                            "jsonrpc": "2.0", "id": request_id,
                            "error": {"code": -32603, "message": "failed"},
                        })
                    return httpx.Response(200, json={"id": "wrong", "result": {}})

                async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                    with self.assertRaises((httpx.HTTPStatusError, RuntimeError)):
                        await McpToolRegistrationService._send_mcp_request(
                            client, "https://example.invalid", "tools/list", {}, {}
                        )


class TokenResolverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.agent_id = str(uuid.uuid4())
        self.tenant_id = str(uuid.uuid4())
        self.resolver = AppTokenResolver()
        self.connection = SimpleNamespace(get_agentic_application_token=AsyncMock(return_value="assertion"))
        self.manager = SimpleNamespace(get_default_connection=lambda: self.connection)

    def token(self, **overrides):
        claims = {
            "appid": self.agent_id,
            "tid": self.tenant_id,
            "aud": "api://9b975845-388f-4429-889e-eab1ef63949c",
            "exp": time.time() + 3600,
        }
        claims.update(overrides)
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return f"header.{payload}.signature"

    async def test_prefetch_uses_host_connection_and_reuses_app_token(self):
        token = self.token()
        with patch("observability.app_token_resolver._acquire", return_value={"access_token": token}) as acquire:
            await self.resolver.prefetch(self.manager, self.tenant_id, self.agent_id)
            await self.resolver.prefetch(self.manager, self.tenant_id, self.agent_id)
        self.connection.get_agentic_application_token.assert_awaited_once_with(self.tenant_id, self.agent_id)
        acquire.assert_called_once_with(self.tenant_id, self.agent_id, "assertion")
        self.assertEqual(self.resolver.resolve(self.agent_id.upper(), self.tenant_id.upper()), token)

    async def test_rejects_delegated_mismatched_and_expired_tokens(self):
        for overrides in (
            {"scp": "scope"},
            {"appid": str(uuid.uuid4())},
            {"tid": str(uuid.uuid4())},
            {"aud": "wrong-audience"},
            {"exp": time.time() - 1},
        ):
            with self.subTest(overrides=overrides):
                self.resolver.clear()
                with patch("observability.app_token_resolver._acquire", return_value={"access_token": self.token(**overrides)}):
                    with self.assertRaises(RuntimeError):
                        await self.resolver.prefetch(self.manager, self.tenant_id, self.agent_id)
                self.assertIsNone(self.resolver.resolve(self.agent_id, self.tenant_id))

    async def test_cached_token_is_not_served_near_expiry(self):
        token = self.token(exp=time.time() + 120)
        with patch("observability.app_token_resolver._acquire", return_value={"access_token": token}):
            await self.resolver.prefetch(self.manager, self.tenant_id, self.agent_id)
        with patch("observability.app_token_resolver.time.time", return_value=time.time() + 61):
            self.assertIsNone(self.resolver.resolve(self.agent_id, self.tenant_id))


class IdentityTests(unittest.TestCase):
    def test_configured_name_overrides_incoming_display_name(self):
        with patch.dict(os.environ, {"AGENT_NAME": "Semantic-Kernel"}):
            details = extract_turn_context_details(self.context(str(uuid.uuid4())))
        self.assertEqual(details.agent_name, "Semantic-Kernel")

    def context(self, runtime_agent_id):
        return SimpleNamespace(activity=SimpleNamespace(
            recipient=SimpleNamespace(
                tenant_id=str(uuid.uuid4()), agentic_app_id=runtime_agent_id,
                name="Test Agent", agentic_user_id=str(uuid.uuid4()), id="channel-bot",
            ),
            conversation=SimpleNamespace(id="conversation"),
            from_property=None,
            channel_id="msteams",
            get_agentic_instance_id=lambda: runtime_agent_id,
        ))

    def test_runtime_identity_and_blueprint_remain_distinct(self):
        runtime_id, blueprint_id = str(uuid.uuid4()), str(uuid.uuid4())
        with patch.dict(os.environ, {"AGENT_BLUEPRINT_ID": blueprint_id}):
            details = extract_turn_context_details(self.context(runtime_id))
        self.assertEqual(details.agent_id, runtime_id)
        self.assertEqual(details.agent_blueprint_id, blueprint_id)

    def test_channel_and_blueprint_ids_are_not_agent_identity_fallbacks(self):
        blueprint_id = str(uuid.uuid4())
        with patch.dict(os.environ, {"AGENT_ID": "", "AGENT_BLUEPRINT_ID": blueprint_id}):
            self.assertIsNone(extract_turn_context_details(self.context(None)).agent_id)
            self.assertIsNone(extract_turn_context_details(self.context(blueprint_id)).agent_id)


class SpanTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_model_invocation_has_one_chat_and_preserves_history(self):
        from openai import AsyncOpenAI
        from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
        exporter = InMemorySpanExporter()
        trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={
                "id": "synthetic-completion", "object": "chat.completion", "created": 1,
                "model": "mock-model",
                "choices": [{"index": 0, "message": {
                    "role": "assistant", "content": "synthetic response"
                }, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4},
            })

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
            client = AsyncOpenAI(api_key="synthetic-key", http_client=http_client)
            agent = SemanticKernelAgent.__new__(SemanticKernelAgent)
            agent.kernel = Kernel()
            agent.kernel.add_service(OpenAIChatCompletion(ai_model_id="mock-model", async_client=client))
            agent.model_name = "mock-model"
            agent.provider_name = "openai"
            agent._chat_histories = {}
            agent.setup_mcp_tools = AsyncMock()
            agent_id, tenant_id, blueprint_id, caller_id, agent_user_id = [
                str(uuid.uuid4()) for _ in range(5)
            ]
            context = SimpleNamespace(activity=Activity(
                type="message", channel_id="msteams",
                recipient=ChannelAccount(
                    id="bot", name="Old Name", role=RoleTypes.agentic_user,
                    agentic_app_id=agent_id, tenant_id=tenant_id,
                    aad_object_id=agent_user_id, agentic_user_id="agent@example.invalid",
                ),
                from_property=ChannelAccount(id="user", aad_object_id=caller_id),
                conversation=ConversationAccount(id="synthetic-conversation", tenant_id=tenant_id),
            ))
            with patch.dict(os.environ, {
                "AGENT_BLUEPRINT_ID": blueprint_id, "AGENT_NAME": "Semantic-Kernel",
                "USE_AZURE_OPENAI": "false",
            }):
                for message in ("synthetic first prompt", "synthetic second prompt"):
                    self.assertEqual(
                        await agent.process_user_message(message, None, context),
                        "synthetic response",
                    )
        self.assertEqual(len(requests), 2)
        self.assertTrue(any(
            m.get("content") == "synthetic first prompt" for m in requests[1]["messages"]
        ))
        spans = exporter.get_finished_spans()
        for operation in ("invoke_agent", "chat", "output_messages"):
            self.assertEqual(sum(
                s.attributes.get("gen_ai.operation.name") == operation for s in spans
            ), 2, f"Unexpected count for {operation}")
        chats = [s for s in spans if s.attributes.get("gen_ai.operation.name") == "chat"]
        for span in chats:
            self.assertEqual(span.attributes["gen_ai.agent.id"], agent_id)
            self.assertEqual(span.attributes["microsoft.agent.user.id"], agent_user_id)
            self.assertEqual(span.attributes["microsoft.a365.agent.blueprint.id"], blueprint_id)
            self.assertEqual(span.attributes["user.id"], caller_id)
            self.assertIn("synthetic response", span.attributes["gen_ai.output.messages"])
            self.assertEqual(span.attributes["server.address"], "api.openai.com")
            self.assertEqual(span.attributes["server.port"], 443)

    async def test_real_kernel_tool_is_wrapped_and_all_operations_share_trace(self):
        exporter = InMemorySpanExporter()
        trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))
        agent = SemanticKernelAgent.__new__(SemanticKernelAgent)
        agent.kernel = Kernel()
        agent.setup_mcp_tools = AsyncMock()
        agent._chat_histories = {}
        agent.model_name = "mock-model"
        agent.provider_name = "mock-provider"

        @kernel_function(name="echo")
        async def echo(text: str) -> str:
            await asyncio.sleep(0)
            return f"echo: {text}"

        agent.kernel.add_function(plugin_name="test", function=echo)

        class FakeChatAgent:
            def __init__(self, kernel, **kwargs):
                self.kernel = kernel

            async def invoke(self, thread, messages):
                result = await self.kernel.invoke(
                    plugin_name="test", function_name="echo",
                    arguments=KernelArguments(text=messages),
                    metadata={"id": "test-call"},
                )
                yield SimpleNamespace(message=SimpleNamespace(
                    content=str(result), metadata={}, items=[],
                ))

        agent_id, tenant_id, blueprint_id, caller_id, agent_user_id = [str(uuid.uuid4()) for _ in range(5)]
        context = SimpleNamespace(activity=Activity(
            type="message", text="hello", channel_id="msteams",
            recipient=ChannelAccount(
                id="bot", name="Test Agent", tenant_id=tenant_id, role=RoleTypes.agentic_user,
                agentic_app_id=agent_id, aad_object_id=agent_user_id,
                agentic_user_id="synthetic-agent@example.invalid",
            ),
            from_property=ChannelAccount(id="channel-user", aad_object_id=caller_id),
            conversation=ConversationAccount(id="conversation", tenant_id=tenant_id),
        ))
        with patch("agent.ChatCompletionAgent", FakeChatAgent), patch.dict(
            os.environ, {"AGENT_BLUEPRINT_ID": blueprint_id, "AGENT_NAME": "Semantic-Kernel"}
        ):
            result = await agent.process_user_message("hello", None, context)

        self.assertEqual(result, "echo: hello")
        spans = exporter.get_finished_spans()
        operations = {span.attributes.get("gen_ai.operation.name") for span in spans}
        self.assertTrue({"invoke_agent", "chat", "execute_tool", "output_messages"} <= operations)
        for operation in ("invoke_agent", "chat", "execute_tool", "output_messages"):
            self.assertEqual(sum(
                span.attributes.get("gen_ai.operation.name") == operation for span in spans
            ), 1, f"Duplicate {operation} spans")
        self.assertEqual(len({span.context.trace_id for span in spans}), 1)
        tool_spans = [span for span in spans if span.attributes.get("gen_ai.operation.name") == "execute_tool"]
        self.assertTrue(any("echo: hello" in str(span.attributes) for span in tool_spans))
        self.assertEqual(tool_spans[0].attributes.get("gen_ai.tool.call.id"), "test-call")
        for span in spans:
            self.assertEqual(span.attributes.get("gen_ai.agent.id"), agent_id)
            self.assertEqual(span.attributes.get("gen_ai.agent.name"), "Semantic-Kernel")
            self.assertEqual(span.attributes.get("gen_ai.conversation.id"), "conversation")
            self.assertEqual(span.attributes.get("microsoft.channel.name"), "msteams")
            self.assertEqual(span.attributes.get("microsoft.a365.agent.blueprint.id"), blueprint_id)
            self.assertEqual(span.attributes.get("microsoft.agent.user.id"), agent_user_id)
            self.assertEqual(span.attributes.get("user.id"), caller_id)
            if span.attributes.get("gen_ai.operation.name") != "output_messages":
                self.assertTrue(span.attributes.get("server.address"))
                self.assertTrue(span.attributes.get("server.port"))
                self.assertEqual(span.attributes.get("client.address"), "0.0.0.0")
        invoke = next(span for span in spans if span.attributes.get("gen_ai.operation.name") == "invoke_agent")
        self.assertEqual(invoke.attributes.get("user.id"), caller_id)
        chat = next(span for span in spans if span.attributes.get("gen_ai.operation.name") == "chat")
        self.assertEqual(chat.attributes.get("gen_ai.request.model"), "mock-model")
        self.assertEqual(chat.attributes.get("gen_ai.provider.name"), "mock-provider")
        self.assertEqual(chat.parent.span_id, invoke.context.span_id)
        self.assertEqual(tool_spans[0].parent.span_id, chat.context.span_id)

        exporter.clear()
        context.activity.recipient.role = None
        with patch("agent.ChatCompletionAgent", FakeChatAgent), patch.dict(
            os.environ, {"AGENT_ID": "", "AGENT_BLUEPRINT_ID": blueprint_id}
        ):
            result = await agent.process_user_message("hello", None, context)
        self.assertEqual(result, "echo: hello")
        self.assertFalse(any(
            span.attributes.get("gen_ai.operation.name") == "invoke_agent"
            for span in exporter.get_finished_spans()
        ))


if __name__ == "__main__":
    unittest.main()
