// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Agent, MCPToolset } from '@google/adk';

import {
  McpToolServerConfigurationService,
  ToolingConfiguration,
  resolveTokenScopeForServer,
} from '@microsoft/agents-a365-tooling';

import type { TurnContext } from '@microsoft/agents-hosting';

// Use axios directly to call the gateway (same as the SDK uses internally)
import axios from 'axios';

const logger = {
  info: (...args: unknown[]) =>
    console.log(new Date().toISOString(), 'INFO', 'McpToolRegistrationService:', ...args),
  warn: (...args: unknown[]) =>
    console.warn(new Date().toISOString(), 'WARN', 'McpToolRegistrationService:', ...args),
  error: (...args: unknown[]) =>
    console.error(new Date().toISOString(), 'ERROR', 'McpToolRegistrationService:', ...args),
};

export interface AddToolServersOptions {
  agent: Agent;
  agenticAppId: string;
  auth: unknown;
  authHandlerName: string | null;
  context: TurnContext;
  authToken?: string;
}

export class McpToolRegistrationService {
  private configService: McpToolServerConfigurationService;

  constructor() {
    this.configService = new McpToolServerConfigurationService();
  }

  /**
   * Add new MCP servers to the agent by creating a new Agent instance.
   */
  async addToolServersToAgent(options: AddToolServersOptions): Promise<Agent> {
    const { agent, agenticAppId, auth, authHandlerName, context, authToken: providedToken } = options;

    let authToken = providedToken;

    if (!authToken && auth && authHandlerName) {
      // Exchange token using the authorization object with the MCP platform scope.
      // The scope comes from ToolingConfiguration (ea9ffc3e-.../.default),
      // NOT https://api.powerplatform.com/.default.
      try {
        const authObj = auth as any;
        if (typeof authObj.exchangeToken === 'function') {
          const mcpScope = new ToolingConfiguration().mcpPlatformAuthenticationScope;
          logger.info(`Exchanging token via auth handler '${authHandlerName}' for MCP scope: ${mcpScope}`);
          const authTokenObj = await authObj.exchangeToken(context, authHandlerName, {
            scopes: [mcpScope],
          });
          authToken = authTokenObj?.token;
          logger.info(`Token exchange result: ${authToken ? `success (length: ${authToken.length})` : 'null/empty'}`);
        } else {
          logger.warn('auth object does not have exchangeToken method');
        }
      } catch (err) {
        logger.error('Token exchange failed:', err);
        return agent;
      }
    }

    if (!authToken) {
      logger.warn('No auth token available for MCP tool servers');
      return agent;
    }

    logger.info(`Listing MCP tool servers for agent: '${agenticAppId}'`);

    let mcpServerConfigs: any[];
    try {
      // Call the A365 tooling gateway directly to handle response shape variations.
      // The SDK's listToolServers expects response.data to be an array, but the
      // gateway may return { mcpServers: [...] } (object with array property).
      const toolingConfig = new ToolingConfiguration();
      const endpoint = `${toolingConfig.mcpPlatformEndpoint}/agents/v2/${agenticAppId}/mcpServers`;
      logger.info(`Gateway URL: ${endpoint}`);

      const response = await axios.get(endpoint, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 10000,
      });

      logger.info(`Gateway response status: ${response.status}`);
      logger.info(`Gateway response type: ${typeof response.data}, isArray: ${Array.isArray(response.data)}`);

      // Handle both shapes: raw array OR { mcpServers: [...] }
      const rawServers = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.data?.mcpServers)
          ? response.data.mcpServers
          : [];

      mcpServerConfigs = rawServers.map((s: any) => ({
        mcpServerName: s.mcpServerName,
        mcpServerUniqueName: s.mcpServerUniqueName ?? s.mcpServerName,
        url: s.url,
        headers: s.headers,
        audience: s.audience,
        scope: s.scope,
        publisher: s.publisher,
      }));

      logger.info(`Loaded ${mcpServerConfigs.length} MCP server configurations`);
      for (const cfg of mcpServerConfigs) {
        logger.info(`  Server: ${cfg.mcpServerUniqueName ?? '(unknown)'}, URL: ${cfg.url ?? '(none)'}`);
      }
    } catch (err: any) {
      logger.error(`Failed to list MCP tool servers:`);
      logger.error(`  agenticAppId: '${agenticAppId}'`);
      logger.error(`  Error: ${err.message}`);
      if (err.response) {
        logger.error(`  HTTP Status: ${err.response.status}`);
        logger.error(`  Response data: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    // Convert MCP server configs to MCPToolset objects
    const mcpServersInfo: MCPToolset[] = [];

    for (const serverConfig of mcpServerConfigs) {
      if (!serverConfig.url) {
        logger.warn(
          `Skipping MCP server '${serverConfig.mcpServerUniqueName}' — no URL configured.`
        );
        continue;
      }

      // MCPToolset requires connectionParams with:
      //   type: "StreamableHTTPConnectionParams" (discriminant for the switch)
      //   url: the server endpoint
      //   header: auth headers (note: singular "header", not "headers")
      const serverInfo = new MCPToolset({
        type: 'StreamableHTTPConnectionParams',
        url: serverConfig.url,
        header: { Authorization: `Bearer ${authToken}` },
      } as any);

      logger.info(`Created MCPToolset for '${serverConfig.mcpServerUniqueName}' at ${serverConfig.url}`);
      mcpServersInfo.push(serverInfo);
    }

    const existingTools = agent.tools ?? [];
    const allTools = [...existingTools, ...mcpServersInfo];

    return new Agent({
      name: agent.name,
      model: agent.model as string,
      description: agent.description,
      instruction: agent.instruction as string,
      tools: allTools,
    });
  }
}
