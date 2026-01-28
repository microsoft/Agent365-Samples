# Copyright (c) Microsoft. All rights reserved.

"""
Agent 365 Tooling Agent Framework Extensions

Agent Framework specific tools and services for AI agent development.
Provides Agent Framework-specific implementations and utilities for
building agents with Microsoft Agent Framework capabilities.

Main Service:
- McpToolRegistrationService: Add MCP tool servers to Agent Framework agents

This module includes implementations for:
- Agent Framework agent creation with MCP (Model Context Protocol) server support
- MCP tool registration service for dynamically adding MCP servers to agents
- Azure OpenAI and OpenAI chat client integration
- Authentication and authorization patterns for MCP server discovery
"""

__version__ = "1.0.0"

# Import services from the services module
from .services import McpToolRegistrationService

__all__ = [
    "McpToolRegistrationService",
]
