# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Observability Configuration Module

Handles one-time initialization of Agent 365 Observability SDK.
This module should be imported early in the application lifecycle to ensure
observability is configured before any agents are instantiated.
"""

import logging
import os

from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.core.exporters.agent365_exporter_options import Agent365ExporterOptions
from observability_token_service import create_observability_token_resolver

logger = logging.getLogger(__name__)

# Flag to track if observability has been configured
_observability_configured = False


def _initialize_observability_once() -> bool:
    """Initialize observability SDK once at module level before any agent instances are created"""
    global _observability_configured

    if _observability_configured:
        logger.debug("Observability already configured, skipping")
        return True

    token_resolver = create_observability_token_resolver()
    try:
        status = configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "claude-sample-agent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
            exporter_options=Agent365ExporterOptions(
                use_s2s_endpoint=True,
                token_resolver=token_resolver,
            ),
        )

        if not status:
            logger.warning("⚠️ Agent 365 Observability configuration failed")
            return False

        _observability_configured = True
        logger.info("✅ Agent 365 Observability configured successfully")
        return True

    except Exception as e:
        logger.error(f"❌ Error setting up observability: {e}")
        return False


def is_observability_configured() -> bool:
    """Check if observability has been configured"""
    return _observability_configured


# Initialize observability immediately at module load time
_initialize_observability_once()
