# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Client wrapper for Microsoft Copilot Studio agents.

Provides a thin abstraction over :class:`CopilotClient` that adds
Agent 365 Observability inference-scope telemetry to every call.
"""

import logging
import os
import time
from typing import Protocol

from microsoft_agents.activity import Activity, ActivityTypes
from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents.copilotstudio.client import (
    CopilotClient,
    ConnectionSettings,
)

# Observability imports — use the Microsoft OpenTelemetry distro package
from microsoft.opentelemetry.a365.core import (
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
    AgentDetails,
    Request,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------


class Client(Protocol):
    """Interface for interacting with Copilot Studio agents."""

    async def invoke_agent(self, message: str) -> str:
        """Send a message and return the agent's response text."""
        ...

    async def invoke_inference_scope(self, prompt: str, context: TurnContext) -> str:
        """Send a message wrapped in an observability inference scope."""
        ...


# ---------------------------------------------------------------------------
# Copilot Studio client implementation
# ---------------------------------------------------------------------------


class McsClient:
    """
    Microsoft Copilot Studio (MCS) client with observability spans.

    The ``Mcs`` prefix indicates that this client is specific to Copilot Studio
    agents, extending :class:`CopilotClient` with Agent 365 Observability
    instrumentation.
    """

    def __init__(self, client: CopilotClient) -> None:
        self._client = client
        self._conversation_id: str = ""

    # -- core send ----------------------------------------------------------

    async def invoke_agent(self, message: str) -> str:
        """
        Send *message* to the Copilot Studio agent and collect the response.

        If no conversation has been started yet the first call will
        automatically start one via :pymethod:`start_conversation`.
        """
        responses: list[str] = []

        try:
            # Start conversation if needed
            if not self._conversation_id:
                async for activity in self._client.start_conversation(
                    emit_start_conversation_event=True,
                ):
                    if hasattr(activity, "conversation") and activity.conversation:
                        conv_id = getattr(activity.conversation, "id", None)
                        if conv_id:
                            self._conversation_id = conv_id
                    if activity.type == ActivityTypes.message and activity.text:
                        responses.append(activity.text)

            # Build user activity
            user_activity = Activity(
                type=ActivityTypes.message,
                text=message,
                conversation={"id": self._conversation_id},
            )

            # Send message and collect responses
            async for activity in self._client.send_activity(user_activity):
                if activity.type == ActivityTypes.message and activity.text:
                    responses.append(activity.text)

            return "\n".join(responses) or "No response from Copilot Studio agent."

        except Exception:
            logger.exception("Error sending message to Copilot Studio")
            raise

    # -- observability wrapper ----------------------------------------------

    async def invoke_inference_scope(self, prompt: str, context: "TurnContext") -> str:
        """
        Send *prompt* wrapped in an Agent 365 Observability inference scope.

        Records input/output messages, response ID, and finish reasons as
        telemetry attributes.
        """
        # Read identity from the incoming activity (set by the A365 platform).
        recipient = context.activity.recipient
        agent_id = (
            getattr(recipient, "agentic_app_id", None)
            or os.getenv("AGENTIC_APP_ID", "")
        )
        tenant_id = (
            getattr(recipient, "tenant_id", None)
            or os.getenv("AGENTIC_TENANT_ID", "")
        )

        inference_details = InferenceCallDetails(
            operationName=InferenceOperationType.CHAT,
            model="copilot-studio-agent",
            providerName="CopilotStudio",
        )

        agent_details = AgentDetails(
            agent_id=agent_id,
            agent_name="Copilot Studio Sample Agent",
            tenant_id=tenant_id,
        )

        request = Request(
            content=prompt,
            conversation_id=self._conversation_id or f"conv-{int(time.time() * 1000)}",
        )

        response = ""
        # InferenceScope.start(request, details, agent_details) — positional args
        with InferenceScope.start(
            request, inference_details, agent_details
        ) as scope:
            try:
                response = await self.invoke_agent(prompt)
                scope.record_input_messages([prompt])
                scope.record_output_messages([response])
                scope.record_finish_reasons(["stop"])
            except Exception as exc:
                scope.record_error(exc)
                raise

        return response


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


async def get_client(
    authorization: Authorization,
    auth_handler_name: str | None,
    turn_context: TurnContext,
) -> McsClient:
    """
    Create a configured :class:`McsClient`.

    Acquires an OBO token for the Power Platform audience and initialises the
    underlying :class:`CopilotClient`.

    Parameters
    ----------
    authorization:
        Agent 365 authorization context for token acquisition.
    auth_handler_name:
        The name of the auth handler to use (typically ``'agentic'``).
    turn_context:
        Bot Framework turn context for the current conversation.
    """
    # Load Copilot Studio connection settings from environment
    settings_dict = ConnectionSettings.populate_from_environment()
    settings = ConnectionSettings(**settings_dict)

    # Acquire token for Copilot Studio API
    if auth_handler_name:
        token_result = await authorization.exchange_token(
            turn_context,
            scopes=["https://api.powerplatform.com/.default"],
            auth_handler_id=auth_handler_name,
        )
        if not token_result or not token_result.token:
            raise RuntimeError(
                "Failed to acquire token for Copilot Studio. "
                "User may need to sign in."
            )
        token = token_result.token
    else:
        # Fallback for local dev without agentic auth
        token = os.getenv("BEARER_TOKEN", "")
        if not token:
            raise RuntimeError(
                "No auth handler and no BEARER_TOKEN set. "
                "Cannot authenticate to Copilot Studio."
            )

    # Create the Copilot Studio client with the token
    copilot_client = CopilotClient(settings, token)

    return McsClient(copilot_client)
