# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Offline FMI and real exporter tests; no Entra/LLM/Teams/A365 calls."""

import ast
import base64
import importlib.util
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs
from urllib.request import OpenerDirector

import pytest
import requests
from microsoft_agents_a365.observability.core.exporters.agent365_exporter import (
    _Agent365Exporter,
)
from microsoft_agents_a365.observability.core.exporters.agent365_exporter_options import (
    Agent365ExporterOptions,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.trace import SpanContext, TraceFlags

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = (
    "openai/sample-agent",
    "claude/sample-agent",
    "crewai/sample_agent",
    "google-adk/sample-agent",
    "agent-framework/sample-agent",
    "observability-with-otlp",
    "observability-with-azure-monitor",
    "observability-with-langgraph",
)
BOOTSTRAPS = (
    ("openai/sample-agent/agent.py", "configure"),
    ("claude/sample-agent/observability_config.py", "configure"),
    ("crewai/sample_agent/host_agent_server.py", "configure_observability"),
    ("crewai/sample_agent/start_with_generic_host.py", "configure_observability"),
    ("google-adk/sample-agent/main.py", "configure"),
    ("agent-framework/sample-agent/host_agent_server.py", "use_microsoft_opentelemetry"),
    ("observability-with-otlp/main.py", "configure"),
    ("observability-with-azure-monitor/main.py", "configure"),
    ("observability-with-langgraph/main.py", "configure"),
)
TENANT = "11111111-1111-1111-1111-111111111111"
AGENT = "22222222-2222-2222-2222-222222222222"
BLUEPRINT = "33333333-3333-3333-3333-333333333333"
OTHER = "44444444-4444-4444-4444-444444444444"
SECRET = "offline-blueprint-credential"
NOW = 1_800_000_000
ENV = {
    "AGENT365_OBS_TENANT_ID": TENANT,
    "AGENT365_OBS_AGENT_ID": AGENT,
    "AGENT365_OBS_BLUEPRINT_CLIENT_ID": BLUEPRINT,
    "AGENT365_OBS_BLUEPRINT_CLIENT_SECRET": SECRET,
}


@pytest.fixture(autouse=True)
def prohibit_network(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("Unexpected network call in offline test")

    monkeypatch.setattr(OpenerDirector, "open", fail)
    monkeypatch.setattr(requests.Session, "request", fail)
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("ENABLE_A365_OBSERVABILITY_EXPORTER", raising=False)
    monkeypatch.delenv("A365_OBSERVABILITY_DOMAIN_OVERRIDE", raising=False)


@pytest.fixture(params=SAMPLES)
def service(request, monkeypatch):
    path = ROOT / "python" / request.param / "observability_token_service.py"
    spec = importlib.util.spec_from_file_location("obs_" + request.param.replace("/", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.time, "time", lambda: NOW)
    return module


def claims(service, **changes):
    value = {
        "tid": TENANT,
        "azp": AGENT,
        "aud": f"api://{service.OBSERVABILITY_RESOURCE}",
        "roles": ["Observability.Write"],
        "idtyp": "app",
        "exp": NOW + 3600,
    }
    value.update(changes)
    return value


@pytest.fixture(params=["roles", "roles-absent", "roles-empty", "legacy-roles", "oid-eq-sub"])
def app_token_claims(service, request):
    value = claims(service)
    if request.param == "roles-absent":
        del value["roles"]
    elif request.param == "roles-empty":
        value["roles"] = []
    elif request.param == "legacy-roles":
        del value["idtyp"]
    elif request.param == "oid-eq-sub":
        del value["idtyp"]
        del value["roles"]
        value["oid"] = AGENT
        value["sub"] = AGENT
    return value


def jwt(value):
    def encode(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{encode({'alg': 'RS256'})}.{encode(value)}.offline-signature"


def response(token, **changes):
    value = {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
    value.update(changes)
    return value


def resolver(service):
    return service.ObservabilityTokenResolver(TENANT, AGENT, BLUEPRINT, SECRET)


def http_mock(monkeypatch, results):
    sent = []

    def send(self, request, timeout):
        assert request.get_method() == "POST"
        assert request.full_url == f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token"
        assert request.get_header("Content-type") == "application/x-www-form-urlencoded"
        assert timeout == 30
        sent.append({key: values[0] for key, values in parse_qs(request.data.decode()).items()})
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        body = io.BytesIO(json.dumps(result).encode())
        body.status = 200
        return body

    monkeypatch.setattr(OpenerDirector, "open", send)
    return sent


def test_copies_stay_standalone_and_identical():
    copies = [(ROOT / "python" / sample / "observability_token_service.py").read_bytes()
              for sample in SAMPLES]
    assert all(copy == copies[0] for copy in copies)
    tree = ast.parse(copies[0])
    imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert not any(name.startswith(("token_cache", "microsoft_agents", "autonomous"))
                   for name in imports)


def test_concurrent_exports_share_only_one_acquisition(service, monkeypatch, app_token_claims):
    token = jwt(app_token_claims)
    sent = http_mock(monkeypatch, [response("t1"), response(token)])
    acquire = resolver(service)
    with ThreadPoolExecutor(max_workers=8) as executor:
        values = list(executor.map(lambda _: acquire(AGENT, TENANT), range(16)))
    assert values == [token] * 16
    assert len(sent) == 2


def test_exact_two_step_fmi_fields_and_cache(service, monkeypatch, app_token_claims):
    token = jwt(app_token_claims)
    sent = http_mock(monkeypatch, [response("offline-t1"), response(token)])
    acquire = resolver(service)
    assert acquire(AGENT, TENANT) == token
    assert acquire(AGENT, TENANT) == token
    assert sent == [
        {
            "client_id": BLUEPRINT,
            "client_secret": SECRET,
            "scope": "api://AzureADTokenExchange/.default",
            "grant_type": "client_credentials",
            "fmi_path": AGENT,
        },
        {
            "client_id": AGENT,
            "scope": "api://9b975845-388f-4429-889e-eab1ef63949c/.default",
            "grant_type": "client_credentials",
            "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            "client_assertion": "offline-t1",
        },
    ]
    assert all("requested_token_use" not in item and "user_fic" not in item
               and "assertion" not in item for item in sent)


@pytest.mark.parametrize("expiry_source", ["expires_in", "exp", "both"])
def test_refresh_uses_real_expiry(service, monkeypatch, expiry_source, app_token_claims):
    first_claims = app_token_claims.copy()
    first_response = {"expires_in": 3600}
    if expiry_source in ("expires_in", "both"):
        first_response["expires_in"] = 120
    if expiry_source in ("exp", "both"):
        first_claims["exp"] = NOW + 180
    first = jwt(first_claims)
    second = jwt({**app_token_claims, "jti": "refreshed"})
    sent = http_mock(monkeypatch, [
        response("t1"), response(first, **first_response),
        response("t1-refresh"), response(second),
    ])
    acquire = resolver(service)
    assert acquire(AGENT, TENANT) == first
    expiry = 180 if expiry_source == "exp" else 120
    monkeypatch.setattr(service.time, "time", lambda: NOW + expiry - 61)
    assert acquire(AGENT, TENANT) == first
    assert len(sent) == 2
    monkeypatch.setattr(service.time, "time", lambda: NOW + expiry - 60)
    assert acquire(AGENT, TENANT) == second
    assert len(sent) == 4


@pytest.mark.parametrize("source", ["exp", "expires_in"])
def test_single_expiry_source_is_supported(service, monkeypatch, source, app_token_claims):
    token_claims = app_token_claims.copy()
    result = response(jwt(token_claims))
    if source == "expires_in":
        del token_claims["exp"]
        result["access_token"] = jwt(token_claims)
    else:
        del result["expires_in"]
    http_mock(monkeypatch, [response("t1"), result])
    assert resolver(service)(AGENT, TENANT) == result["access_token"]


@pytest.mark.parametrize("bad_claims", [
    {"scp": "access_as_user"}, {"scp": ""}, {"scp": None}, {"scp": []}, {"scp": False},
    {"idtyp": "user"}, {"idtyp": None}, {"idtyp": ""}, {"idtyp": "App"},
    {"idtyp": False}, {"idtyp": 1}, {"idtyp": []}, {"idtyp": {}},
    {"tid": OTHER}, {"tid": None}, {"tid": ""}, {"azp": OTHER}, {"appid": OTHER},
    {"azp": None}, {"appid": None}, {"azp": OTHER, "appid": AGENT},
    {"azp": None, "appid": AGENT}, {"azp": "", "appid": AGENT},
    {"aud": "https://graph.microsoft.com"}, {"aud": None},
    {"aud": ["api://9b975845-388f-4429-889e-eab1ef63949c"]},
    {"exp": NOW - 1}, {"exp": NOW + 30}, {"exp": NOW + 60}, {"exp": None},
    {"exp": True}, {"exp": "bad"}, {"exp": float("inf")}, {"exp": float("nan")},
])
def test_rejects_delegated_mismatched_and_expired_tokens(
    service, monkeypatch, bad_claims, app_token_claims,
):
    value = {**app_token_claims, **bad_claims}
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


@pytest.mark.parametrize("roles", [
    None, "Observability.Write", {}, 1, False, [None], [1], [True], [[]], [{}],
    [""], [" \t\n"], ["Observability.Write", " "],
])
@pytest.mark.parametrize("has_idtyp", [True, False])
def test_rejects_malformed_application_roles(service, monkeypatch, roles, has_idtyp):
    value = claims(service, roles=roles)
    if not has_idtyp:
        del value["idtyp"]
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


@pytest.mark.parametrize("roles_present", [True, False])
def test_roleless_tokens_without_app_signals_fail_closed(service, monkeypatch, roles_present):
    # No idtyp, no roles, and no oid==sub — the token has no app-only signal.
    value = claims(service, roles=[])
    del value["idtyp"]
    if not roles_present:
        del value["roles"]
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


@pytest.mark.parametrize("bad_oid_sub", [
    {"oid": AGENT, "sub": "delegated-user-oid"},
    {"oid": AGENT, "sub": ""},
    {"oid": "", "sub": ""},
    {"oid": None, "sub": None},
    {"oid": AGENT},
    {"sub": AGENT},
])
def test_roleless_oid_sub_fallback_requires_matching_nonempty_strings(
    service, monkeypatch, bad_oid_sub,
):
    value = claims(service, roles=[])
    del value["idtyp"]
    del value["roles"]
    value.update(bad_oid_sub)
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


def test_roleless_oid_sub_fallback_rejects_delegated_scp(service, monkeypatch):
    value = claims(service, roles=[])
    del value["idtyp"]
    del value["roles"]
    value["oid"] = AGENT
    value["sub"] = AGENT
    value["scp"] = "User.Read"
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


@pytest.mark.parametrize("missing_claim", ["tid", "azp", "aud"])
def test_missing_token_identity_fails_closed(
    service, monkeypatch, missing_claim, app_token_claims,
):
    value = app_token_claims.copy()
    del value[missing_claim]
    http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    acquire = resolver(service)
    with pytest.raises(service.ObservabilityTokenError):
        acquire(AGENT, TENANT)
    assert acquire._token is None


@pytest.mark.parametrize("expires_in", [None, "bad", -1, 0, True, float("inf"), float("nan")])
def test_invalid_lifetime_fails_closed(service, monkeypatch, expires_in):
    http_mock(monkeypatch, [response("t1"), response(jwt(claims(service)), expires_in=expires_in)])
    with pytest.raises(service.ObservabilityTokenError):
        resolver(service)(AGENT, TENANT)


def test_missing_expiry_fails_closed(service, monkeypatch):
    value = claims(service)
    del value["exp"]
    result = response(jwt(value))
    del result["expires_in"]
    http_mock(monkeypatch, [response("t1"), result])
    with pytest.raises(service.ObservabilityTokenError, match="lacks expires_in/exp"):
        resolver(service)(AGENT, TENANT)


@pytest.mark.parametrize("first_step", [True, False])
@pytest.mark.parametrize("failure", [
    {}, {"access_token": "", "token_type": "Bearer"},
    {"access_token": "opaque", "token_type": "Bearer"},
    {"access_token": "opaque", "token_type": "Basic"},
    {"access_token": "opaque", "token_type": None},
    {"error": "invalid_client", "error_description": SECRET},
])
def test_bad_responses_never_return_empty_success(service, monkeypatch, first_step, failure):
    # An opaque T1 is permitted; the final OBS response must be an app JWT.
    results = [failure] if first_step else [response("t1"), failure]
    if first_step and failure == {"access_token": "opaque", "token_type": "Bearer"}:
        results.append(response("malformed-final-token"))
    http_mock(monkeypatch, results)
    with pytest.raises(service.ObservabilityTokenError) as error:
        resolver(service)(AGENT, TENANT)
    assert SECRET not in str(error.value)


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500])
def test_http_failure_is_sanitized_and_no_stale_fallback(
    service, monkeypatch, status, caplog, app_token_claims,
):
    token = jwt(app_token_claims)
    error = HTTPError("offline", status, SECRET, {}, io.BytesIO(SECRET.encode()))
    sent = http_mock(monkeypatch, [
        response("t1"), response(token, expires_in=120),
        response("t1-refresh"), error,
        URLError(SECRET),
    ])
    acquire = resolver(service)
    assert acquire(AGENT, TENANT) == token
    monkeypatch.setattr(service.time, "time", lambda: NOW + 61)
    with pytest.raises(service.ObservabilityTokenError, match=f"HTTP {status}") as caught:
        acquire(AGENT, TENANT)
    assert SECRET not in str(caught.value)
    assert "instance registration" in str(caught.value)
    assert "service policy" in str(caught.value)
    assert acquire._token is None
    with pytest.raises(service.ObservabilityTokenError) as caught:
        acquire(AGENT, TENANT)
    assert SECRET not in str(caught.value)
    assert len(sent) == 5
    assert SECRET not in caplog.text and token not in caplog.text


@pytest.mark.parametrize("agent,tenant", [(OTHER, TENANT), (AGENT, OTHER), ("", TENANT), (None, TENANT)])
def test_export_identity_mismatch_never_makes_request(service, agent, tenant):
    with pytest.raises(service.ObservabilityConfigurationError):
        resolver(service)(agent, tenant)


@pytest.mark.parametrize("key", tuple(ENV))
@pytest.mark.parametrize("value", [None, "", "<<YOUR_VALUE>>"])
def test_active_export_rejects_missing_or_placeholder_config(service, monkeypatch, key, value):
    for name, configured in ENV.items():
        monkeypatch.setenv(name, configured)
    monkeypatch.setenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "true")
    if value is None:
        monkeypatch.delenv(key)
    else:
        monkeypatch.setenv(key, value)
    with pytest.raises(service.ObservabilityConfigurationError, match=key):
        service.create_observability_token_resolver()


def test_blueprint_is_never_inferred_as_agent(service, monkeypatch):
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AGENT365_OBS_AGENT_ID", BLUEPRINT)
    with pytest.raises(service.ObservabilityConfigurationError, match="must differ"):
        service.create_observability_token_resolver(enabled=True)
    monkeypatch.delenv("AGENT365_OBS_AGENT_ID")
    monkeypatch.setenv("AGENT_ID", BLUEPRINT)
    monkeypatch.setenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID", BLUEPRINT)
    with pytest.raises(service.ObservabilityConfigurationError, match="AGENT365_OBS_AGENT_ID"):
        service.create_observability_token_resolver(enabled=True)


@pytest.mark.parametrize("secret", ["...", "replace-me", "YOUR_SECRET", "dummy", "***"])
def test_common_secret_placeholders_are_rejected(service, secret):
    with pytest.raises(service.ObservabilityConfigurationError, match="BLUEPRINT_CLIENT_SECRET"):
        service.ObservabilityTokenResolver(TENANT, AGENT, BLUEPRINT, secret)


def test_disabled_export_does_not_require_credentials(service):
    assert service.create_observability_token_resolver() is None


@pytest.mark.parametrize("enabled", ["true", "TRUE", "1", "yes", "on"])
def test_all_sdk_enablement_values_fail_clearly_without_config(service, monkeypatch, enabled):
    monkeypatch.setenv("ENABLE_A365_OBSERVABILITY_EXPORTER", enabled)
    with pytest.raises(service.ObservabilityConfigurationError):
        service.create_observability_token_resolver()


@pytest.mark.parametrize("has_azp", [True, False])
def test_v1_appid_claim_is_supported(service, monkeypatch, app_token_claims, has_azp):
    value = {**app_token_claims, "appid": AGENT, "aud": service.OBSERVABILITY_RESOURCE}
    if not has_azp:
        del value["azp"]
    token = jwt(value)
    http_mock(monkeypatch, [response("t1"), response(token)])
    assert resolver(service)(AGENT, TENANT) == token


def test_redirects_cannot_forward_blueprint_credentials(service):
    assert service._NoRedirect().redirect_request(
        None, None, 302, "Found", {}, "https://untrusted.invalid",
    ) is None


@pytest.mark.parametrize("path,configure_name", BOOTSTRAPS)
def test_bootstrap_uses_factory_and_preserves_s2s_options(path, configure_name):
    tree = ast.parse((ROOT / "python" / path).read_text())
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name)]
    factory = next(node for node in calls if node.func.id == "create_observability_token_resolver")
    configure = next(node for node in calls if node.func.id == configure_name)
    assert factory.lineno < configure.lineno
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            assert factory not in list(ast.walk(ast.Module(body=node.body, type_ignores=[])))
    if configure_name == "use_microsoft_opentelemetry":
        keywords = {item.arg: item.value for item in configure.keywords}
        assert ast.literal_eval(keywords["a365_use_s2s_endpoint"]) is True
        assert ast.literal_eval(factory.keywords[0].value) is True
        assert isinstance(keywords["a365_token_resolver"], ast.Name)
    else:
        options = next(item.value for item in configure.keywords if item.arg == "exporter_options")
        marker = object()
        actual = eval(compile(ast.Expression(options), path, "eval"), {
            "Agent365ExporterOptions": Agent365ExporterOptions, "os": os,
            "token_resolver": marker, "self": SimpleNamespace(token_resolver=marker),
        })
        assert actual.use_s2s_endpoint is True
        assert actual.token_resolver is marker


@pytest.mark.parametrize("path,configure_name", BOOTSTRAPS)
def test_actual_bootstrap_factory_assignment_rejects_missing_config(
    service, monkeypatch, path, configure_name,
):
    monkeypatch.setenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "true")
    tree = ast.parse((ROOT / "python" / path).read_text())
    assignment = next(
        node for node in ast.walk(tree) if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
        and node.value.func.id == "create_observability_token_resolver"
    )
    program = ast.Module(body=[assignment], type_ignores=[])
    with pytest.raises(service.ObservabilityConfigurationError):
        exec(compile(program, path, "exec"), {
            "self": SimpleNamespace(),
            "create_observability_token_resolver": service.create_observability_token_resolver,
        })


@pytest.mark.parametrize("scenario", ["ai-teammate", "obo"])
@pytest.mark.parametrize("status", [202, 401, 403])
def test_real_s2s_export_uses_app_token_preserves_user_baggage(
    service, monkeypatch, scenario, status, app_token_claims,
):
    token = jwt(app_token_claims)
    token_requests = http_mock(monkeypatch, [response("t1"), response(token)])
    uploads = []

    def send(session, method, url, **kwargs):
        assert method.lower() == "post"
        uploads.append((url, kwargs["headers"], json.loads(kwargs["data"])))
        result = requests.Response()
        result.status_code = status
        result._content = b"{}"
        return result

    monkeypatch.setattr(requests.Session, "request", send)
    monkeypatch.setenv("A365_USE_S2S_ENDPOINT", "false")
    exporter = _Agent365Exporter(
        token_resolver=resolver(service), cluster_category="prod", use_s2s_endpoint=True,
    )
    attributes = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": AGENT,
        "microsoft.tenant.id": TENANT,
        "user.id": OTHER,
        "user.name": "Offline delegated caller",
        "microsoft.channel.name": scenario,
    }
    span = ReadableSpan(
        name="invoke_agent offline",
        context=SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED)),
        resource=Resource.create({"service.name": "offline-app-only"}),
        attributes=attributes, start_time=1, end_time=2,
    )
    try:
        result = exporter.export([span])
    finally:
        exporter.shutdown()
    assert result == (SpanExportResult.SUCCESS if status == 202 else SpanExportResult.FAILURE)
    assert len(token_requests) == 2 and len(uploads) == 1
    url, headers, body = uploads[0]
    assert url == (
        "https://agent365.svc.cloud.microsoft/observabilityService"
        f"/tenants/{TENANT}/otlp/agents/{AGENT}/traces?api-version=1"
    )
    assert headers["authorization"] == f"Bearer {token}"
    exported = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"]
    for key, value in attributes.items():
        assert exported[key] == value


@pytest.mark.parametrize("failure", [
    "token-endpoint", "delegated", "empty-scp", "roleless-without-idtyp",
    "invalid-idtyp", "malformed-roles", "identity-mismatch",
])
def test_export_failure_does_not_upload_or_fall_back(service, monkeypatch, failure):
    if failure == "token-endpoint":
        sent = http_mock(monkeypatch, [URLError(SECRET)])
    else:
        value = claims(service)
        if failure in ("delegated", "empty-scp"):
            value["scp"] = "access_as_user" if failure == "delegated" else ""
        elif failure == "roleless-without-idtyp":
            del value["roles"]
            del value["idtyp"]
        elif failure == "invalid-idtyp":
            value["idtyp"] = None
        elif failure == "malformed-roles":
            value["roles"] = [" "]
        sent = http_mock(monkeypatch, [response("t1"), response(jwt(value))])
    uploads = []
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: uploads.append(args))
    exporter = _Agent365Exporter(
        token_resolver=resolver(service), cluster_category="prod", use_s2s_endpoint=True,
    )
    span = ReadableSpan(
        name="invoke_agent offline",
        context=SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED)),
        resource=Resource.create({"service.name": "offline-app-only"}),
        attributes={
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.id": OTHER if failure == "identity-mismatch" else AGENT,
            "microsoft.tenant.id": TENANT,
            "user.id": OTHER,
        },
        start_time=1, end_time=2,
    )
    try:
        assert exporter.export([span]) == SpanExportResult.FAILURE
    finally:
        exporter.shutdown()
    assert not uploads
    assert len(sent) == {"token-endpoint": 1, "identity-mismatch": 0}.get(failure, 2)


@pytest.mark.parametrize("sample", [
    "observability-with-otlp", "observability-with-azure-monitor", "observability-with-langgraph",
])
def test_standalone_demo_core_imports_support_required_sdk(sample):
    tree = ast.parse((ROOT / "python" / sample / "main.py").read_text())
    imports = [node for node in tree.body if isinstance(node, ast.ImportFrom)
               and node.module.startswith("microsoft_agents_a365.observability.core")]
    namespace = {}
    exec(compile(ast.Module(body=imports, type_ignores=[]), sample, "exec"), namespace)
    assert namespace["configure"]


@pytest.mark.parametrize("sample", SAMPLES)
def test_template_and_readme_document_all_dedicated_settings(sample):
    for name in (".env.template", "README.md"):
        text = (ROOT / "python" / sample / name).read_text()
        for setting in ENV:
            assert setting in text


def test_host_paths_no_longer_exchange_obs_user_tokens():
    for sample in ("openai/sample-agent", "claude/sample-agent", "crewai/sample_agent",
                   "agent-framework/sample-agent"):
        source = (ROOT / "python" / sample / "host_agent_server.py").read_text()
        assert "get_observability_authentication_scope" not in source
        assert "cache_agentic_token" not in source
        assert "BaggageBuilder" in source
    for sample in ("claude/sample-agent", "crewai/sample_agent", "google-adk/sample-agent"):
        source = (ROOT / "python" / sample / "mcp_tool_registration_service.py").read_text()
        assert "auth.exchange_token(" in source
