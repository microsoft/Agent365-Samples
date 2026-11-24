// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365 MCP — single instance shared by client.ts and agent.ts.
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-langchain';

export const mcpToolService = new McpToolRegistrationService();
