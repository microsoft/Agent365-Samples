import { McpToolServerConfigurationService, McpClientTool, MCPServerConfig } from '@microsoft/agents-a365-tooling';
import { AgenticAuthenticationService, Authorization, Utility as RuntimeUtility } from '@microsoft/agents-a365-runtime';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TurnContext } from '@microsoft/agents-hosting';

export type McpServer = MCPServerConfig & {
  type: string,
  requestInit: {
    headers?: Record<string, string>;
  },
  tools: McpClientTool[]
};

/**
 * Discover MCP servers and list tools
 * Use getMcpServers to fetch server configs and getTools to enumerate tools.
 */
export class McpToolRegistrationService {
  private configService: McpToolServerConfigurationService = new McpToolServerConfigurationService();

  async getMcpServers(
    authHandlerName: string,
    turnContext: TurnContext,
    authToken: string
  ): Promise<McpServer[]> {
    const authorization = turnContext.turnState.get('authorization');
    if (!authToken) {
      authToken = await AgenticAuthenticationService.GetAgenticUserToken(authorization, authHandlerName, turnContext);
    }
   // Get the agentic user ID from authorization configuration
    const agenticAppId = RuntimeUtility.ResolveAgentIdentity(turnContext, authToken);

    const mcpServers: McpServer[] = [];
    const servers = await this.configService.listToolServers(agenticAppId, authToken);

    for (const server of servers) {
      // Compose headers if values are available
      const headers: Record<string, string> = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      // Add each server to the config object
      const mcpServer = {
        mcpServerName: server.mcpServerName,
        url: server.url,
        requestInit: {
          headers: headers
        }
      } as McpServer;

      const tools = await this.getTools(mcpServer);
      mcpServer.tools = tools;
      mcpServers.push(mcpServer);
    }
    return mcpServers;
  }

  /**
   * Connect to the MCP server and return tools
   * Throws if the server URL is missing or the client fails to list tools.
   */
  async getTools(mcpServerConfig: McpServer): Promise<McpClientTool[]> {
    if (!mcpServerConfig) {
      throw new Error('Invalid MCP Server Configuration');
    }

    if (!mcpServerConfig.url) {
      throw new Error('MCP Server URL cannot be null or empty');
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(mcpServerConfig.url),
      {
        requestInit: mcpServerConfig.requestInit
      }
    );

    const mcpClient = new Client({
      name: mcpServerConfig.mcpServerName,
      version: '1.0',
    });

    await mcpClient.connect(transport);
    const toolsObj = await mcpClient.listTools();
    await mcpClient.close();

    const tools = toolsObj.tools.map(tool => ({
      name: mcpServerConfig.mcpServerName,
      description: tool.description,
      inputSchema: tool.inputSchema
    })) as McpClientTool[];

    return tools;
  }
}

