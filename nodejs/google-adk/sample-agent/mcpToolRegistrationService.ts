// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Agent, MCPToolset, type BaseTool, type ReadonlyContext } from '@google/adk';

import {
  ToolingConfiguration,
  resolveTokenScopeForServer,
} from '@microsoft/agents-a365-tooling';

import type { Authorization, TurnContext } from '@microsoft/agents-hosting';

// A365 Observability — best-effort instrumentation (verify against official sample)
import { ExecuteToolScope } from '@microsoft/opentelemetry';
import { getTurnTelemetry, type TurnTelemetry } from './observability/turn-context';
import { validateDevelopmentToken, withCancellation } from './mcpInitialization';

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
  signal?: AbortSignal;
}

interface McpServerConfig {
  mcpServerName?: string;
  mcpServerUniqueName?: string;
  url?: string;
  audience?: string;
  scope?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTokenExchange(auth: unknown): auth is Pick<Authorization, 'exchangeToken'> {
  return isRecord(auth) && typeof auth.exchangeToken === 'function';
}

class ObservableMCPToolset extends MCPToolset {
  private readonly instrumented = new WeakSet<BaseTool>();

  constructor(
    connectionParams: ConstructorParameters<typeof MCPToolset>[0],
    private readonly telemetry: TurnTelemetry | undefined
  ) {
    super(connectionParams);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = await super.getTools(context);
    const telemetry = this.telemetry;
    if (!telemetry) return tools;
    for (const tool of tools) {
      if (this.instrumented.has(tool)) continue;
      this.instrumented.add(tool);
      const run = tool.runAsync.bind(tool);
      tool.runAsync = async (request) => {
        const captureContent = process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME;
        const scope = ExecuteToolScope.start(telemetry.request, {
          toolName: tool.name,
          toolType: 'function',
          toolCallId: request.toolContext.functionCallId,
          arguments: captureContent ? request.args : undefined,
          description: tool.description,
        }, telemetry.agentDetails, telemetry.userDetails);
        try {
          return await scope.withActiveSpanAsync(async () => {
            const result = await run(request);
            if (isRecord(result) && result.isError === true) {
              scope.recordError(new Error('MCP tool returned an application error (isError=true).'));
            }
            if (captureContent) scope.recordResponse(JSON.stringify(result) ?? '');
            return result;
          });
        } catch (error) {
          scope.recordError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          scope.dispose();
        }
      };
    }
    return tools;
  }
}

export class McpToolRegistrationService {
  /**
   * Add new MCP servers to the agent by creating a new Agent instance.
   */
  async addToolServersToAgent(options: AddToolServersOptions): Promise<Agent> {
    const { agent, agenticAppId, auth, authHandlerName, context, authToken: providedToken } = options;

    let authToken = validateDevelopmentToken(providedToken);
    const signal = options.signal ?? AbortSignal.timeout(60_000);
    signal.throwIfAborted();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agenticAppId)) {
      logger.error('MCP discovery requires a valid runtime agent instance ID.');
      throw new Error('Configure AGENTIC_APP_ID for local bearer-token tooling or supply an agentic activity.');
    }
    const sharedScope = new ToolingConfiguration().mcpPlatformAuthenticationScope;
    const exchange = async (scope: string): Promise<string> => {
      if (!hasTokenExchange(auth) || !authHandlerName) {
        logger.error('V2 MCP servers require resource-specific tokens; a discovery bearer token is insufficient.');
        throw new Error('Configure AUTH_HANDLER_NAME=AGENTIC and its service connection for V2 MCP servers.');
      }
      signal.throwIfAborted();
      const result = await withCancellation(
        auth.exchangeToken(context, authHandlerName, { scopes: [scope] }), signal
      );
      if (!result?.token) {
        logger.error('MCP workload token exchange returned no token; inspect agentic authorization diagnostics.');
        throw new Error('MCP authorization failed. Verify the blueprint connection name and workload permissions.');
      }
      return result.token;
    };

    if (!authToken && auth && authHandlerName) {
      // Exchange token using the authorization object with the MCP platform scope.
      // The scope comes from ToolingConfiguration (ea9ffc3e-.../.default),
      // NOT https://api.powerplatform.com/.default.
      logger.info('Acquiring MCP discovery token through agentic authorization');
      authToken = await exchange(sharedScope);
    }

    if (!authToken) {
      logger.warn('No auth token available for MCP tool servers');
      return agent;
    }

    logger.info('Listing MCP tool servers');

    let mcpServerConfigs: McpServerConfig[];
    try {
      // Call the A365 tooling gateway directly to handle response shape variations.
      // The SDK's listToolServers expects response.data to be an array, but the
      // gateway may return { mcpServers: [...] } (object with array property).
      const toolingConfig = new ToolingConfiguration();
      const endpoint = `${toolingConfig.mcpPlatformEndpoint}/agents/v2/${encodeURIComponent(agenticAppId)}/mcpServers`;
      const response = await withCancellation(fetch(endpoint, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal,
      }), signal);
      logger.info(`Gateway response status: ${response.status}`);
      if (!response.ok) throw new Error(`MCP discovery failed (HTTP ${response.status}).`);
      let data: unknown;
      try {
        data = await withCancellation(response.json(), signal);
      } catch {
        signal.throwIfAborted();
        throw new Error('Invalid JSON in MCP discovery response.');
      }

      // Handle both shapes: raw array OR { mcpServers: [...] }
      const rawServers: unknown = Array.isArray(data) ? data : isRecord(data) ? data.mcpServers : undefined;
      if (!Array.isArray(rawServers)) throw new Error('Invalid MCP discovery response: expected an array of servers.');
      mcpServerConfigs = rawServers.map((server: unknown) => {
        if (!isRecord(server) ||
            ['mcpServerName', 'mcpServerUniqueName', 'url', 'audience', 'scope'].some(key =>
              server[key] !== undefined && typeof server[key] !== 'string')) {
          throw new Error('Invalid MCP server configuration.');
        }
        return {
          mcpServerName: typeof server.mcpServerName === 'string' ? server.mcpServerName : undefined,
          mcpServerUniqueName: typeof server.mcpServerUniqueName === 'string' ? server.mcpServerUniqueName : undefined,
          url: typeof server.url === 'string' ? server.url : undefined,
          audience: typeof server.audience === 'string' ? server.audience : undefined,
          scope: typeof server.scope === 'string' ? server.scope : undefined,
        };
      });

      logger.info(`Loaded ${mcpServerConfigs.length} MCP server configurations`);
    } catch (err) {
      logger.error('Failed to list MCP tool servers; check gateway status, credentials, and connectivity.');
      throw err;
    }

    // Convert MCP server configs to MCPToolset objects
    const mcpServersInfo: MCPToolset[] = [];
    const telemetry = getTurnTelemetry(context, agent.name);
    const tokensByScope = new Map<string, string>([[sharedScope, authToken]]);

    try {
      for (const serverConfig of mcpServerConfigs) {
        signal.throwIfAborted();
        if (!serverConfig.url) {
          logger.warn(
            `Skipping MCP server '${serverConfig.mcpServerUniqueName}' — no URL configured.`
          );
          continue;
        }

        const serverScope = resolveTokenScopeForServer({
          mcpServerName: serverConfig.mcpServerName ?? serverConfig.mcpServerUniqueName ?? '',
          url: serverConfig.url,
          audience: serverConfig.audience,
          scope: serverConfig.scope,
        }, sharedScope);
        let serverToken = tokensByScope.get(serverScope);
        if (!serverToken) {
          serverToken = await exchange(serverScope);
          tokensByScope.set(serverScope, serverToken);
        }

        const serverInfo = new ObservableMCPToolset({
          type: 'StreamableHTTPConnectionParams',
          url: serverConfig.url,
          header: { Authorization: `Bearer ${serverToken}` },
        }, telemetry);

        logger.info('Created MCP toolset');
        mcpServersInfo.push(serverInfo);
      }
      signal.throwIfAborted();

      return new Agent({
        name: agent.name,
        model: agent.model,
        description: agent.description,
        instruction: agent.instruction,
        tools: [...(agent.tools ?? []), ...mcpServersInfo],
      });
    } catch (error) {
      const cleanup = await Promise.allSettled(mcpServersInfo.map(toolset => toolset.close()));
      if (cleanup.some(result => result.status === 'rejected')) {
        logger.error('Failed to close one or more partially initialized MCP toolsets.');
      }
      throw error;
    }
  }
}
