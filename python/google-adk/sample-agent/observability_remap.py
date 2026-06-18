# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Span operation-name remap for the Google ADK sample agent.

Google ADK auto-instrumentation tags the LLM call with
``gen_ai.operation.name = "generate_content"`` (the Google GenAI semantic
convention). Microsoft Agent 365 / Maven ingestion only accepts four
operation names — ``invoke_agent``, ``execute_tool``, ``chat`` and
``output_messages`` — and drops every other span before fan-out. As a
result the ADK inference span (model, token usage, finish reason) never
reaches Maven.

This module rewrites ``generate_content`` -> ``chat`` on export using the
A365 observability SDK's public enricher hook (``register_span_enricher``),
so the inference span maps onto Maven's InferenceCall table. The original
span is never mutated; an :class:`EnrichedReadableSpan` overlay is returned
with the single attribute overridden.

No changes to the A365 SDK or to Maven are required.
"""

import logging

from opentelemetry.sdk.trace import ReadableSpan

from microsoft_agents_a365.observability.core.constants import (
    CHAT_OPERATION_NAME,
    EXECUTE_TOOL_OPERATION_NAME,
    GEN_AI_OPERATION_NAME_KEY,
    INVOKE_AGENT_OPERATION_NAME,
    OUTPUT_MESSAGES_OPERATION_NAME,
)
from microsoft_agents_a365.observability.core.exporters.enriched_span import (
    EnrichedReadableSpan,
)
from microsoft_agents_a365.observability.core.exporters.enriching_span_processor import (
    get_span_enricher,
    register_span_enricher,
    unregister_span_enricher,
)

logger = logging.getLogger(__name__)

# The Google GenAI semantic-convention operation name (emitted only when the
# optional ``opentelemetry-instrumentation-google-genai`` package is installed).
_SOURCE_OPERATION_NAME = "generate_content"

# Attribute set by ADK's ``trace_call_llm`` on the inference span. ADK does NOT
# set ``gen_ai.operation.name`` on this span, so without a remap it is dropped by
# the Agent 365 exporter (which only keeps invoke_agent/execute_tool/chat/
# output_messages). Presence of this attribute identifies an inference call.
_GEN_AI_REQUEST_MODEL_KEY = "gen_ai.request.model"

# Operation names the Agent 365 exporter already considers eligible. A span that
# already carries one of these must never be relabelled.
_RECOGNIZED_OPERATION_NAMES = frozenset(
    {
        INVOKE_AGENT_OPERATION_NAME,
        EXECUTE_TOOL_OPERATION_NAME,
        OUTPUT_MESSAGES_OPERATION_NAME,
        CHAT_OPERATION_NAME,
    }
)


def _remap_generate_content_to_chat(span: ReadableSpan) -> ReadableSpan:
    """Map an ADK / Google GenAI inference span onto the ``chat`` operation.

    Two shapes are handled:

    1. ``gen_ai.operation.name == "generate_content"`` — emitted by the optional
       ``opentelemetry-instrumentation-google-genai`` package.
    2. ADK's own ``call_llm`` span, which sets ``gen_ai.request.model`` but no
       ``gen_ai.operation.name`` at all. This is the default for google-adk
       without the genai instrumentation package, and is the case in this
       sample.

    Any span that already carries a recognized operation name (invoke_agent,
    execute_tool, chat, output_messages) is returned unchanged.
    """
    attributes = span.attributes or {}
    operation_name = attributes.get(GEN_AI_OPERATION_NAME_KEY)

    # Never relabel a span that already has an eligible operation name.
    if operation_name in _RECOGNIZED_OPERATION_NAMES:
        return span

    is_genai_generate_content = operation_name == _SOURCE_OPERATION_NAME
    is_adk_inference_span = (
        operation_name is None
        and attributes.get(_GEN_AI_REQUEST_MODEL_KEY) is not None
    )
    if not (is_genai_generate_content or is_adk_inference_span):
        return span

    return EnrichedReadableSpan(
        span,
        extra_attributes={GEN_AI_OPERATION_NAME_KEY: CHAT_OPERATION_NAME},
    )


def register_generate_content_remap() -> None:
    """Register the ``generate_content`` -> ``chat`` enricher with the SDK.

    The SDK allows a single enricher at a time. If another enricher is already
    registered (e.g. a platform instrumentor), this composes with it: the
    existing enricher runs first, then the remap is applied to its result.
    Safe to call once during application startup, after ``configure()``.
    """
    existing = get_span_enricher()

    if existing is None:
        enricher = _remap_generate_content_to_chat
    else:
        def enricher(span: ReadableSpan) -> ReadableSpan:
            return _remap_generate_content_to_chat(existing(span))

        # Replace the existing single-slot enricher with the composed one.
        unregister_span_enricher()

    register_span_enricher(enricher)
    logger.info(
        "Registered span enricher: %s -> %s remap",
        _SOURCE_OPERATION_NAME,
        CHAT_OPERATION_NAME,
    )
