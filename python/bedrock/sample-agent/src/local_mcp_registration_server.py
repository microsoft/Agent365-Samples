# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Tool Registration Service for Amazon Bedrock Agent

This service provides MCP (Model Context Protocol) tool integration for Bedrock agents
by creating and managing an AWS AgentCore Gateway that aggregates MCP servers.
"""

from typing import Optional, Tuple
from dataclasses import dataclass
import logging
import os
import boto3

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.runtime.utility import Utility
from microsoft_agents_a365.tooling.models import ToolOptions
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)


@dataclass
class MCPGatewayConfig:
    """Configuration for an AgentCore Gateway"""
    gateway_id: str
    gateway_arn: str
    gateway_url: str
    name: str


class McpToolRegistrationService:
    """
    Service for managing MCP tools via AWS AgentCore Gateway for Bedrock agents.

    This service creates/manages an AgentCore Gateway and adds discovered MCP servers
    as targets, enabling Bedrock agents to access Agent 365 platform tools.
    """

    def __init__(
        self,
        logger: Optional[logging.Logger] = None,
        region: Optional[str] = None
    ):
        """
        Initialize the MCP Tool Registration Service for Bedrock.

        Args:
            logger: Logger instance for logging operations.
            region: AWS region for AgentCore Gateway (defaults to AWS_REGION env var)
        """
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self._region = region or os.getenv("AWS_REGION", "us-east-1")
        self._config_service = McpToolServerConfigurationService(logger=self._logger)
        self._gateway_config: Optional[MCPGatewayConfig] = None

        # Initialize AWS Bedrock AgentCore client
        try:
            self._agentcore_client = boto3.client('bedrock-agentcore', region_name=self._region)
            self._logger.info(f"Initialized Bedrock AgentCore client in region: {self._region}")
        except Exception as e:
            self._logger.error(f"Failed to initialize Bedrock AgentCore client: {e}")
            self._agentcore_client = None

    async def add_tool_servers_to_agent(
        self,
        agent,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
        gateway_name: Optional[str] = None,
    ) -> Tuple[object, MCPGatewayConfig]:
        """
        Add MCP tool servers to a Bedrock agent via AgentCore Gateway.

        This creates/retrieves an AgentCore Gateway, discovers MCP servers from the
        configuration service, adds them as gateway targets, and synchronizes the gateway.

        Args:
            agent: The Bedrock agent instance (returned unchanged for compatibility)
            auth: Authorization object for token exchange
            auth_handler_name: Name of the auth handler
            context: TurnContext object representing the current turn/session
            auth_token: Optional pre-configured authentication token
            gateway_name: Optional custom gateway name

        Returns:
            Tuple of (agent, gateway_config) where gateway_config contains the
            gateway URL that the agent can use to access MCP tools
        """
        if not self._agentcore_client:
            raise RuntimeError("Bedrock AgentCore client not initialized")

        # Step 1: Get authentication token
        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            auth_result = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_result.token

        # Step 2: Discover MCP servers using SDK configuration service
        options = ToolOptions(orchestrator_name=self._orchestrator_name)
        agentic_app_id = Utility.resolve_agent_identity(context, auth_token)
        mcp_server_configs = await self._config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token,
            options=options
        )
        self._logger.info(f"Loaded {len(mcp_server_configs)} MCP server configurations")

        # Step 3: Create or get AgentCore Gateway
        gateway_name = gateway_name or f"Agent365-Gateway-{agentic_app_id}"
        gateway_config = await self._create_or_get_gateway(gateway_name)

        # Step 4: Add MCP servers as gateway targets
        target_ids = []
        for server_config in mcp_server_configs:
            try:
                target_id = await self._add_gateway_target(
                    server_name=server_config.mcp_server_name,
                    server_url=server_config.mcp_server_unique_name,
                    auth_token=auth_token,
                    gateway_id=gateway_config.gateway_id
                )
                if target_id:
                    target_ids.append(target_id)
                    self._logger.info(f"Added target: {server_config.mcp_server_name}")
            except Exception as e:
                self._logger.warning(f"Failed to add target {server_config.mcp_server_name}: {e}")

        # Step 5: Synchronize gateway to discover tools
        if target_ids:
            await self._synchronize_gateway(gateway_config.gateway_id, target_ids)

        self._logger.info(f"MCP integration complete. Gateway URL: {gateway_config.gateway_url}")
        self._logger.info(f"Agent can connect to MCP endpoint: {gateway_config.gateway_url}/mcp")

        return agent, gateway_config

    async def _create_or_get_gateway(self, gateway_name: str) -> MCPGatewayConfig:
        """
        Create a new AgentCore Gateway or retrieve existing one.

        Args:
            gateway_name: Name for the gateway

        Returns:
            MCPGatewayConfig with gateway details
        """
        # Check if already cached
        if self._gateway_config and self._gateway_config.name == gateway_name:
            self._logger.info(f"Using cached gateway: {gateway_name}")
            return self._gateway_config

        # Check if gateway exists
        self._logger.info(f"Checking for existing gateway: {gateway_name}")
        try:
            response = self._agentcore_client.list_mcp_gateways()
            for gateway in response.get('gateways', []):
                if gateway.get('name') == gateway_name:
                    self._logger.info(f"Found existing gateway: {gateway_name}")
                    self._gateway_config = MCPGatewayConfig(
                        gateway_id=gateway['gatewayId'],
                        gateway_arn=gateway['gatewayArn'],
                        gateway_url=gateway['gatewayUrl'],
                        name=gateway_name
                    )
                    return self._gateway_config
        except Exception as e:
            self._logger.warning(f"Error checking existing gateways: {e}")

        # Create new gateway
        self._logger.info(f"Creating new AgentCore Gateway: {gateway_name}")
        gateway_response = self._agentcore_client.create_mcp_gateway(
            name=gateway_name,
            description=f"MCP Gateway for Agent {gateway_name}"
        )

        self._gateway_config = MCPGatewayConfig(
            gateway_id=gateway_response['gatewayId'],
            gateway_arn=gateway_response['gatewayArn'],
            gateway_url=gateway_response['gatewayUrl'],
            name=gateway_name
        )

        self._logger.info(f"Created gateway: {self._gateway_config.gateway_id}")
        return self._gateway_config

    async def _add_gateway_target(
        self,
        server_name: str,
        server_url: str,
        auth_token: str,
        gateway_id: str
    ) -> Optional[str]:
        """
        Add an MCP server as a target to the AgentCore Gateway.

        Args:
            server_name: Server display name
            server_url: Server URL endpoint
            auth_token: Authentication token
            gateway_id: Gateway identifier

        Returns:
            Target ID if successful, None otherwise
        """
        try:
            target_config = {
                "name": server_name,
                "description": f"MCP Server: {server_name}",
                "targetConfiguration": {
                    "mcp": {
                        "mcpServer": {
                            "endpoint": server_url
                        }
                    }
                }
            }

            # Add bearer token authentication
            if auth_token:
                target_config["credentialProviderConfigurations"] = [{
                    "credentialProviderType": "BEARER_TOKEN",
                    "credentialProvider": {
                        "bearerTokenProvider": {
                            "token": auth_token
                        }
                    }
                }]

            response = self._agentcore_client.create_mcp_gateway_target(
                gatewayIdentifier=gateway_id,
                **target_config
            )

            return response['targetId']

        except Exception as e:
            self._logger.error(f"Failed to add gateway target {server_name}: {e}")
            return None

    async def _synchronize_gateway(self, gateway_id: str, target_ids: list) -> None:
        """
        Synchronize gateway targets to discover tools from all MCP servers.

        Args:
            gateway_id: Gateway identifier
            target_ids: List of target IDs to synchronize
        """
        try:
            self._logger.info(f"Synchronizing {len(target_ids)} gateway targets...")
            self._agentcore_client.synchronize_gateway_targets(
                gatewayIdentifier=gateway_id,
                targetIdList=target_ids
            )
            self._logger.info("Gateway synchronization complete")
        except Exception as e:
            self._logger.error(f"Failed to synchronize gateway: {e}")

    def get_gateway_mcp_endpoint(self) -> Optional[str]:
        """
        Get the MCP endpoint URL for the gateway.

        Returns:
            MCP endpoint URL or None if gateway not initialized
        """
        if not self._gateway_config:
            return None
        return f"{self._gateway_config.gateway_url}/mcp"

    def get_gateway_config(self) -> Optional[MCPGatewayConfig]:
        """
        Get the current gateway configuration.

        Returns:
            MCPGatewayConfig or None if gateway not initialized
        """
        return self._gateway_config
