# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Mocked HTTP coverage; does not validate real AI Teammate/OBO authorization."""

import ast
import json
from types import SimpleNamespace

import pytest
import requests
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.trace import SpanContext, TraceFlags

from microsoft_agents_a365.observability.core.exporters.agent365_exporter import (
    _Agent365Exporter,
)
from microsoft_agents_a365.observability.core.exporters.agent365_exporter_options import (
    Agent365ExporterOptions,
)

from test_s2s_configuration import configure_call, source


@pytest.mark.parametrize("scenario", ["ai-teammate", "obo"])
@pytest.mark.parametrize("status", [202, 401, 403, 500])
def test_interactive_export_has_no_legacy_route_fallback(monkeypatch, scenario, status):
    tenant_id = "11111111-1111-1111-1111-111111111111"
    agent_id = "22222222-2222-2222-2222-222222222222"
    user_id = "33333333-3333-3333-3333-333333333333"
    token = f"offline-{scenario}-token"
    resolver_calls = []
    requests_sent = []

    def token_resolver(agent, tenant):
        resolver_calls.append((agent, tenant))
        return token

    # Evaluate the actual sample's options expression, without importing its agent.
    path = "python/openai/sample-agent/agent.py"
    call = configure_call(ast.parse(source(path)), "legacy")
    expression = next(kw.value for kw in call.keywords if kw.arg == "exporter_options")
    options = eval(compile(ast.Expression(expression), path, "eval"), {
        "Agent365ExporterOptions": Agent365ExporterOptions,
        "self": SimpleNamespace(token_resolver=token_resolver),
    })

    def send(session, method, url, **kwargs):
        assert method.lower() == "post"
        requests_sent.append((url, kwargs["headers"], json.loads(kwargs["data"])))
        response = requests.Response()
        response.status_code = status
        response._content = b"{}"
        return response

    monkeypatch.setattr(requests.Session, "request", send)
    monkeypatch.setattr(
        "microsoft_agents_a365.observability.core.exporters.agent365_exporter.time.sleep",
        lambda _: None,
    )
    monkeypatch.delenv("A365_OBSERVABILITY_DOMAIN_OVERRIDE", raising=False)
    monkeypatch.setenv("A365_USE_S2S_ENDPOINT", "false")
    exporter = _Agent365Exporter(
        token_resolver=options.token_resolver,
        cluster_category=options.cluster_category,
        use_s2s_endpoint=options.use_s2s_endpoint,
    )
    attributes = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": agent_id,
        "microsoft.tenant.id": tenant_id,
        "user.id": user_id,
        "user.name": "Offline Test User",
        "microsoft.channel.name": scenario,
    }
    span = ReadableSpan(
        name="invoke_agent offline",
        context=SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED)),
        resource=Resource.create({"service.name": "offline-s2s-regression"}),
        attributes=attributes,
        start_time=1,
        end_time=2,
    )
    try:
        result = exporter.export([span])
    finally:
        exporter.shutdown()

    assert result == (SpanExportResult.SUCCESS if status == 202 else SpanExportResult.FAILURE)
    assert resolver_calls == [(agent_id, tenant_id)]
    assert len(requests_sent) == (4 if status == 500 else 1)
    for url, headers, payload in requests_sent:
        assert url == (
            "https://agent365.svc.cloud.microsoft/observabilityService"
            f"/tenants/{tenant_id}/otlp/agents/{agent_id}/traces?api-version=1"
        )
        assert headers["authorization"] == f"Bearer {token}"
        exported = payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        assert exported["attributes"]["gen_ai.agent.id"] == agent_id
        assert exported["attributes"]["microsoft.tenant.id"] == tenant_id
        assert exported["attributes"]["user.id"] == user_id
        assert exported["attributes"]["microsoft.channel.name"] == scenario
