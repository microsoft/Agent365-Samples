# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#!/usr/bin/env python3
"""
Example: Direct usage of Generic Agent Host with CrewAI wrapper.

IMPORTANT: Observability must be configured BEFORE importing CrewAI 
to prevent CrewAI from setting up its own TracerProvider.
"""

import sys
import os

# ============================================================
# CRITICAL: Configure observability BEFORE importing CrewAI
# CrewAI sets up its own TracerProvider which would override ours
# ============================================================
def _configure_observability_early():
    """Configure observability before any CrewAI imports."""
    from dotenv import load_dotenv
    load_dotenv()
    
    enable_observability = os.getenv("ENABLE_OBSERVABILITY", "true").lower() in ("true", "1", "yes")
    if not enable_observability:
        print("ℹ️ Observability disabled (ENABLE_OBSERVABILITY=false)")
        return
    
    try:
        # Import and configure observability FIRST
        from microsoft_agents_a365.observability.core.config import configure as configure_observability
        from token_cache import get_cached_agentic_token
        
        service_name = os.getenv("OBSERVABILITY_SERVICE_NAME", "crewai-agent-sample")
        service_namespace = os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples")
        
        def token_resolver(agent_id: str, tenant_id: str) -> str | None:
            """Resolve authentication token for observability exporter"""
            return get_cached_agentic_token(tenant_id, agent_id)
        
        configure_observability(
            service_name=service_name,
            service_namespace=service_namespace,
            token_resolver=token_resolver,
            cluster_category=os.getenv("PYTHON_ENVIRONMENT", "development"),
        )
        print("✅ Observability configured (before CrewAI import)")
    except Exception as e:
        print(f"⚠️ Failed to configure observability early: {e}")

# Configure observability BEFORE importing CrewAI
_configure_observability_early()

try:
    from agent import CrewAIAgent
    from host_agent_server import create_and_run_host
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure you're running from the correct directory")
    sys.exit(1)


def main():
    """Main entry point - start the generic host with CrewAIAgent."""
    try:
        print("Starting Generic Agent Host with CrewAIAgent...")
        print()
        create_and_run_host(CrewAIAgent)
    except Exception as e:
        print(f"Failed to start server: {e}")
        import traceback

        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
