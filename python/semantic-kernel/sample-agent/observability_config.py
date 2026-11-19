# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# A365 Observability — best-effort instrumentation (verify against official sample)
"""Initialize observability before importing Semantic Kernel or the LLM clients."""

import os
import logging

from dotenv import load_dotenv

load_dotenv()

from microsoft.opentelemetry import use_microsoft_opentelemetry
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource

from observability.app_token_resolver import AppTokenResolver

def configure_console_logging() -> None:
    """Keep the distro handler and add one console sink for application diagnostics."""
    root = logging.getLogger()
    root.setLevel(os.getenv("OTEL_LOG_LEVEL", "INFO").upper())
    if not any(handler.name == "semantic-kernel-console" for handler in root.handlers):
        handler = logging.StreamHandler()
        handler.set_name("semantic-kernel-console")
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [Semantic-Kernel] %(name)s: %(message)s"
        ))
        root.addHandler(handler)
    exporter_level = os.getenv("A365_OBSERVABILITY_LOG_LEVEL", "info|warn|error").lower()
    logging.getLogger("microsoft.opentelemetry.a365").setLevel(
        logging.DEBUG if "debug" in exporter_level.split("|") else logging.INFO
    )
    for name in ("httpx", "httpcore", "openai", "msal"):
        logging.getLogger(name).setLevel(logging.WARNING)


configure_console_logging()

OBS_TOKENS = AppTokenResolver()
EXPORT_ENABLED = os.getenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "false").lower() == "true"

use_microsoft_opentelemetry(
    enable_a365=True,
    a365_enable_observability_exporter=EXPORT_ENABLED,
    a365_use_s2s_endpoint=True,
    a365_token_resolver=OBS_TOKENS.resolve,
    a365_exporter_disable_offline_storage=True,
    # Manual model spans already capture messages/usage; avoid a second OpenAI span.
    instrumentation_options={
        "openai": {"enabled": False},
        "openai_agents": {"enabled": False},
        "agent_framework": {"enabled": False},
        "langchain": {"enabled": False},
        "semantic_kernel": {"enabled": False},
    },
    resource=Resource.create({
        "service.name": os.getenv("OBSERVABILITY_SERVICE_NAME") or os.getenv("AGENT_NAME") or "Semantic-Kernel",
        "service.namespace": os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
    }),
)
configure_console_logging()
logging.getLogger(__name__).info(
    "Observability initialized: export=%s, transport=S2S, token=app-only",
    EXPORT_ENABLED,
)


def is_observability_configured() -> bool:
    return True


def shutdown_observability() -> None:
    provider = trace.get_tracer_provider()
    if hasattr(provider, "force_flush"):
        provider.force_flush()
    if hasattr(provider, "shutdown"):
        provider.shutdown()
    OBS_TOKENS.clear()
