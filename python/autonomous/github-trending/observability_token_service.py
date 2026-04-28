# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Background task that acquires an Observability API token via a 3-hop FMI chain
and caches it for the A365 exporter.

Token flow:
  Hop 1+2: Blueprint authenticates (MSI in prod, client secret locally) ->
           gets T1 via acquire_token_for_client with fmi_path targeting Agent Identity.
  Hop 3:   Agent Identity uses T1 as assertion -> Observability API token.

Auth strategy is controlled by AGENT365_USE_MANAGED_IDENTITY:
  true  (production)  - MSI -> Blueprint FIC -> Agent Identity -> API
  false (local dev)   - Client Secret -> Blueprint FIC -> Agent Identity -> API
"""

import asyncio
import logging
from datetime import timedelta

import msal
from azure.identity.aio import ManagedIdentityCredential

import token_cache

logger = logging.getLogger(__name__)

FMI_SCOPES = ["api://AzureADTokenExchange/.default"]
OBSERVABILITY_SCOPES = ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"]
REFRESH_INTERVAL_SECONDS = 50 * 60  # 50 minutes


async def run_token_service(
    tenant_id: str,
    agent_id: str,
    blueprint_client_id: str,
    blueprint_client_secret: str,
    use_managed_identity: bool,
) -> None:
    """Run the background token acquisition loop."""
    logger.info("ObservabilityTokenService started (use_managed_identity=%s).", use_managed_identity)

    while True:
        try:
            await _acquire_and_register_token(
                tenant_id, agent_id, blueprint_client_id, blueprint_client_secret, use_managed_identity
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "Failed to acquire observability token; will retry in %d seconds.",
                REFRESH_INTERVAL_SECONDS,
                exc_info=True,
            )

        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)


async def _acquire_and_register_token(
    tenant_id: str,
    agent_id: str,
    blueprint_client_id: str,
    blueprint_client_secret: str,
    use_managed_identity: bool,
) -> None:
    authority = f"https://login.microsoftonline.com/{tenant_id}"

    # Hop 1+2: Blueprint -> T1 via FMI path
    if use_managed_identity:
        t1_token = await _acquire_t1_via_msi(authority, blueprint_client_id, agent_id)
    else:
        t1_token = _acquire_t1_via_client_secret(authority, blueprint_client_id, blueprint_client_secret, agent_id)

    # Hop 3: Agent Identity uses T1 -> Observability API token
    identity_app = msal.ConfidentialClientApplication(
        client_id=agent_id,
        client_credential={"client_assertion": t1_token},
        authority=authority,
    )
    obs_result = identity_app.acquire_token_for_client(scopes=OBSERVABILITY_SCOPES)

    if "access_token" not in obs_result:
        raise RuntimeError(f"Failed to acquire observability token: {obs_result.get('error_description', obs_result)}")

    token_cache.cache_token(agent_id, tenant_id, obs_result["access_token"], expires_in=timedelta(minutes=55))
    logger.info("Observability token registered for agent %s.", agent_id)


async def _acquire_t1_via_msi(authority: str, blueprint_client_id: str, agent_id: str) -> str:
    """Acquire T1 token using Managed Identity (production)."""
    credential = ManagedIdentityCredential()
    msi_token = await credential.get_token("api://AzureADTokenExchange")
    await credential.close()

    blueprint_app = msal.ConfidentialClientApplication(
        client_id=blueprint_client_id,
        client_credential={"client_assertion": msi_token.token},
        authority=authority,
    )
    result = blueprint_app.acquire_token_for_client(scopes=FMI_SCOPES, fmi_path=agent_id)
    if "access_token" not in result:
        raise RuntimeError(f"FMI T1 via MSI failed: {result.get('error_description', result)}")
    return result["access_token"]


def _acquire_t1_via_client_secret(
    authority: str, blueprint_client_id: str, blueprint_client_secret: str, agent_id: str
) -> str:
    """Acquire T1 token using client secret (local dev)."""
    blueprint_app = msal.ConfidentialClientApplication(
        client_id=blueprint_client_id,
        client_credential=blueprint_client_secret,
        authority=authority,
    )
    result = blueprint_app.acquire_token_for_client(scopes=FMI_SCOPES, fmi_path=agent_id)
    if "access_token" not in result:
        raise RuntimeError(f"FMI T1 via client secret failed: {result.get('error_description', result)}")
    return result["access_token"]
