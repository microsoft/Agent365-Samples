# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Offline configuration regressions, not token acquisition or live export tests."""

import ast
import asyncio
import json
import math
import os
from pathlib import Path
import re
import tomllib
from types import SimpleNamespace
from datetime import timedelta

import pytest


ROOT = Path(__file__).resolve().parents[2]
PYTHON_CONFIGS = {
    "python/agent-framework/sample-agent/host_agent_server.py": "distro",
    "python/autonomous/github-trending/main.py": "distro",
    "python/claude/sample-agent/observability_config.py": "legacy",
    "python/crewai/sample_agent/host_agent_server.py": "legacy",
    "python/crewai/sample_agent/start_with_generic_host.py": "legacy",
    "python/google-adk/sample-agent/main.py": "legacy",
    "python/observability-with-azure-monitor/main.py": "legacy",
    "python/observability-with-langgraph/main.py": "legacy",
    "python/observability-with-otlp/main.py": "legacy",
    "python/openai/sample-agent/agent.py": "legacy",
}
NODE_CONFIGS = {
    "nodejs/claude/sample-agent/src/otel.ts": "distro",
    "nodejs/langchain/sample-agent/src/index.ts": "distro",
    "nodejs/autonomous/github-trending/src/index.ts": "exporter",
    "nodejs/openai/sample-agent/src/otel.ts": "legacy",
    "nodejs/copilot-studio/sample-agent/src/otel.ts": "legacy",
    "nodejs/devin/sample-agent/src/otel.ts": "legacy",
    "nodejs/perplexity/sample-agent/src/otel.ts": "legacy",
    "nodejs/vercel-sdk/sample-agent/src/otel.ts": "legacy",
}
DOTNET_CONFIGS = {
    "dotnet/agent-framework/sample-agent/Program.cs": ["o.Agent365.Exporter"],
    "dotnet/semantic-kernel/sample-agent/Program.cs": ["o.Agent365.Exporter"],
    "dotnet/autonomous/github-trending/sample-agent/Program.cs": ["o.Agent365.Exporter"],
    "dotnet/w365-computer-use/sample-agent/Telemetry/ObservabilityServiceCollectionExtensions.cs":
        ["options.Agent365", "options"],
}


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def configure_call(tree, kind):
    names = {"use_microsoft_opentelemetry"} if kind == "distro" else {
        "configure", "configure_observability",
    }
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in names
    ]
    assert len(calls) == 1
    return calls[0]


@pytest.mark.parametrize("path,kind", PYTHON_CONFIGS.items())
def test_python_s2s_is_literal_and_preserves_resolver(path, kind):
    tree = ast.parse(source(path), filename=path)
    call = configure_call(tree, kind)
    keywords = {kw.arg: kw.value for kw in call.keywords}
    if kind == "distro":
        flag = keywords["a365_use_s2s_endpoint"]
        assert isinstance(flag, ast.Constant) and flag.value is True
        assert "a365_token_resolver" in keywords
        return

    options = keywords["exporter_options"]
    assert isinstance(options, ast.Call)
    assert isinstance(options.func, ast.Name)
    assert options.func.id == "Agent365ExporterOptions"
    assert any(
        isinstance(node, ast.ImportFrom)
        and node.module == (
            "microsoft_agents_a365.observability.core.exporters.agent365_exporter_options"
        )
        and any(alias.name == "Agent365ExporterOptions" for alias in node.names)
        for node in ast.walk(tree)
    ), "Exporter options must be imported, not merely referenced"

    values = {kw.arg: kw.value for kw in options.keywords}
    flag = values["use_s2s_endpoint"]
    assert isinstance(flag, ast.Constant) and flag.value is True
    # An explicit options object bypasses configure's token/cluster defaults.
    assert "token_resolver" not in keywords
    assert "cluster_category" not in keywords
    resolver = lambda agent_id, tenant_id: f"token:{agent_id}:{tenant_id}"
    namespace = {
        "Agent365ExporterOptions": SimpleNamespace,
        "self": SimpleNamespace(token_resolver=resolver),
        "token_resolver": resolver,
        "_stub_token_resolver": resolver,
        "os": os,
    }
    result = eval(compile(ast.Expression(options), path, "eval"), namespace)
    assert result.use_s2s_endpoint is True
    if "google-adk" not in path:
        assert result.token_resolver is resolver
        assert result.token_resolver("agent", "tenant") == "token:agent:tenant"
    if "crewai" in path:
        assert result.cluster_category == os.getenv("PYTHON_ENVIRONMENT", "development")


@pytest.mark.parametrize("path,kind", NODE_CONFIGS.items())
def test_node_s2s_is_explicit_in_exporter_configuration(path, kind):
    text = source(path)
    code = re.sub(r"(?m)^\s*//.*$", "", text)
    assert kind in {"distro", "exporter", "legacy"}
    if kind == "legacy":
        match = re.search(r"(\w+)\.useS2SEndpoint\s*=\s*true;", code)
        assert match
        assert f".withExporterOptions({match.group(1)})" in code
        assert ".withTokenResolver(createObservabilityTokenResolver())" in code
        assert "ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT" in code
    elif kind == "distro":
        assert re.search(r"a365:\s*\{[^}]*useS2SEndpoint:\s*true\b", code)
    else:
        assert re.search(r"new Agent365Exporter\(\{[^}]*useS2SEndpoint:\s*true\b", code)
    assert not re.search(r"useS2SEndpoint\s*[:=]\s*false\b", text)


@pytest.mark.parametrize("path,receivers", DOTNET_CONFIGS.items())
def test_dotnet_s2s_uses_the_published_version_api(path, receivers):
    text = source(path)
    for receiver in receivers:
        assert f"{receiver}.UseS2SEndpoint = true;" in text
    assert not re.search(r"UseS2SEndpoint\s*=\s*false\b", text)


def test_salesforce_metadata_cannot_select_legacy_route():
    text = source(
        "agent-platforms/salesforce/apex-observability/"
        "force-app/main/default/classes/A365ObsConfig.cls"
    )
    accessor = re.search(r"Boolean useS2SEndpoint\(\)\s*\{([^}]+)\}", text).group(1)
    path = re.search(r"String tracesPath\(\)\s*\{([^}]+)\}", text).group(1)
    assert "return true;" in accessor
    assert "UseS2SEndpoint__c" not in accessor
    assert "return '/observabilityService/tenants/' + tenantId()" in path
    assert "'observability'" not in path


def test_all_observability_initializers_are_covered():
    python_paths = set()
    for path in (ROOT / "python").rglob("*.py"):
        if any(part in {".venv", "venv", "node_modules", "__pycache__"} for part in path.parts):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        if any(
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id in {"configure", "configure_observability", "use_microsoft_opentelemetry"}
            for node in ast.walk(tree)
        ):
            python_paths.add(path.relative_to(ROOT).as_posix())
    assert python_paths == set(PYTHON_CONFIGS)

    node_paths = set()
    for path in (ROOT / "nodejs").rglob("*.ts"):
        if any(part in {"node_modules", "dist", "build"} for part in path.parts):
            continue
        if re.search(r"(?:useMicrosoftOpenTelemetry|ObservabilityManager\.configure)\(",
                     path.read_text(encoding="utf-8")):
            node_paths.add(path.relative_to(ROOT).as_posix())
    assert node_paths == set(NODE_CONFIGS)


@pytest.mark.parametrize("name", ["devin", "perplexity", "copilot-studio"])
def test_legacy_node_release_is_pinned_to_compatible_s2s_api(name):
    package = json.loads(source(f"nodejs/{name}/sample-agent/package.json"))
    assert package["dependencies"]["@microsoft/agents-a365-observability"] == "0.1.0-preview.115"
    assert "@microsoft/opentelemetry" not in package["dependencies"]
    if name == "copilot-studio":
        assert package["dependencies"]["@microsoft/agents-a365-observability-hosting"] == "0.1.0-preview.115"


def test_published_distro_does_not_replay_legacy_route_choices():
    package = json.loads(source("nodejs/langchain/sample-agent/package.json"))
    assert package["dependencies"]["@microsoft/opentelemetry"] == "^1.4.0"
    assert "durableDelivery: { enabled: false }" in source("nodejs/langchain/sample-agent/src/index.ts")


@pytest.mark.parametrize("sample", [
    "claude/sample-agent", "crewai/sample_agent", "google-adk/sample-agent",
    "openai/sample-agent", "observability-with-azure-monitor",
    "observability-with-langgraph", "observability-with-otlp",
])
def test_legacy_python_minimum_supports_exporter_options(sample):
    project = tomllib.loads(source(f"python/{sample}/pyproject.toml"))
    requirement = next(
        dependency.replace("_", "-").replace(" ", "")
        for dependency in project["project"]["dependencies"]
        if dependency.replace("_", "-").startswith("microsoft-agents-a365-observability-core")
    )
    assert requirement == "microsoft-agents-a365-observability-core>=1.0.0"


@pytest.mark.parametrize("from_recipient", [True, False])
def test_google_adk_obs_uses_application_identity_not_agent_user(monkeypatch, from_recipient):
    tree = ast.parse(source("python/google-adk/sample-agent/agent.py"))
    assignments = [
        node for node in ast.walk(tree) if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "agent_id"
                for target in node.targets)
    ]
    assert len(assignments) == 1
    application = "22222222-2222-2222-2222-222222222222"
    user = "33333333-3333-3333-3333-333333333333"
    monkeypatch.setenv("AGENT365_OBS_AGENT_ID", application)
    monkeypatch.setenv("AGENTIC_USER_ID", user)
    recipient = SimpleNamespace(
        agentic_app_id=application if from_recipient else None, agentic_user_id=user,
    )
    value = eval(compile(ast.Expression(assignments[0].value), "google-adk", "eval"), {
        "recipient": recipient, "os": os,
    })
    assert value == application
    assert recipient.agentic_user_id == user


def test_autonomous_python_rejects_missing_obs_token():
    path = "python/autonomous/github-trending/main.py"
    tree = ast.parse(source(path))
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_resolve_observability_token"
    )
    cache = SimpleNamespace(get_cached_token=lambda agent, tenant: None)
    namespace = {"token_cache": cache}
    exec(compile(ast.Module(body=[function], type_ignores=[]), path, "exec"), namespace)
    with pytest.raises(RuntimeError, match="unavailable"):
        namespace["_resolve_observability_token"]("agent", "tenant")
    cache.get_cached_token = lambda agent, tenant: "offline-application-token"
    assert namespace["_resolve_observability_token"]("agent", "tenant") == "offline-application-token"


@pytest.mark.parametrize("expiry", [None, True, 0, 300, "invalid", float("nan"), 3600])
def test_autonomous_python_caches_only_reported_valid_expiry(expiry):
    path = "python/autonomous/github-trending/observability_token_service.py"
    tree = ast.parse(source(path))
    function = next(
        node for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_acquire_and_register_token"
    )
    cached = []
    result = {"access_token": "offline-app-token", "expires_in": expiry}
    namespace = {
        "msal": SimpleNamespace(ConfidentialClientApplication=lambda **kwargs:
            SimpleNamespace(acquire_token_for_client=lambda **kwargs: result)),
        "_acquire_t1_via_client_secret": lambda *args: "offline-parent",
        "OBSERVABILITY_SCOPES": ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"],
        "token_cache": SimpleNamespace(cache_token=lambda *args, **kwargs: cached.append((args, kwargs))),
        "logger": SimpleNamespace(info=lambda *args: None), "timedelta": timedelta, "math": math,
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), path, "exec"), namespace)
    operation = namespace["_acquire_and_register_token"]("tenant", "agent", "blueprint", "secret", False)
    if expiry == 3600:
        asyncio.run(operation)
        assert cached[0][1]["expires_in"] == timedelta(hours=1)
    else:
        with pytest.raises(RuntimeError, match="expiry"):
            asyncio.run(operation)
        assert cached == []
