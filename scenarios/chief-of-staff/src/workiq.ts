// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'node:fs';
import path from 'node:path';
import { Agent, MCPServerStreamableHttp } from '@openai/agents';
import type { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { AgenticAuthenticationService } from '@microsoft/agents-a365-runtime';
import { Utility } from '@microsoft/agents-a365-tooling';

const SHARED_MCP_SCOPE = 'ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default';

interface WorkIqServerConfig {
  mcpServerName?: string;
  mcpServerUniqueName?: string;
  url?: string;
  audience?: string;
  scope?: string;
  headers?: Record<string, string>;
}

interface ToolingManifest {
  mcpServers?: WorkIqServerConfig[];
}

type ResolvedWorkIqServerConfig = WorkIqServerConfig & {
  mcpServerName: string;
  url: string;
};

function loadConfiguredServers(): ResolvedWorkIqServerConfig[] {
  const manifestPath = path.join(process.cwd(), 'ToolingManifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`ToolingManifest.json was not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ToolingManifest;
  if (!Array.isArray(manifest.mcpServers)) {
    throw new Error('ToolingManifest.json must contain an mcpServers array');
  }

  return manifest.mcpServers.map((server) => {
    const mcpServerName = server.mcpServerName ?? server.mcpServerUniqueName;
    if (!mcpServerName || !server.url) {
      throw new Error('Every WorkIQ server requires mcpServerName and url');
    }
    return { ...server, mcpServerName, url: server.url };
  });
}

export function resolveWorkIqTokenScope(server: WorkIqServerConfig): string {
  if (!server.audience) return SHARED_MCP_SCOPE;
  return server.scope
    ? `${server.audience}/${server.scope}`
    : `${server.audience}/.default`;
}

async function getServerToken(
  server: WorkIqServerConfig & { mcpServerName: string },
  authorization: Authorization,
  authHandlerName: string,
  turnContext: TurnContext
): Promise<string> {
  const envKey = `BEARER_TOKEN_${server.mcpServerName.toUpperCase()}`;
  const configuredToken = process.env[envKey]?.trim();
  const sharedToken =
    resolveWorkIqTokenScope(server) === SHARED_MCP_SCOPE ? process.env.BEARER_TOKEN?.trim() : undefined;
  const devAuth = process.env.USE_AGENTIC_AUTH?.trim().toLowerCase() === 'false';

  if (devAuth) {
    // Static tokens are development-only. Require an explicit
    // NODE_ENV=development (index.ts treats anything else, including unset,
    // as non-dev) so a deployment can never fall back to copied dev tokens.
    if (process.env.NODE_ENV?.trim().toLowerCase() !== 'development') {
      throw new Error(
        'USE_AGENTIC_AUTH=false (static WorkIQ bearer tokens) is only allowed when NODE_ENV=development'
      );
    }
    if (configuredToken) return configuredToken;
    if (sharedToken) return sharedToken;
    throw new Error(
      `${envKey} is required for local V2 WorkIQ authentication when USE_AGENTIC_AUTH=false`
    );
  }

  if (configuredToken || sharedToken) {
    // Reject the conflict instead of silently overriding the agentic identity.
    throw new Error(
      `${configuredToken ? envKey : 'BEARER_TOKEN'} is set but USE_AGENTIC_AUTH is not 'false'. Static bearer tokens are development-only — remove it, or set USE_AGENTIC_AUTH=false for local testing.`
    );
  }

  const scope = resolveWorkIqTokenScope(server);
  const token = await AgenticAuthenticationService.GetAgenticUserToken(
    authorization,
    authHandlerName,
    turnContext,
    [scope]
  );
  if (!token) {
    throw new Error(`Failed to obtain a WorkIQ token for ${server.mcpServerName}`);
  }
  return token;
}

// A365 WorkIQ — added by add-workiq-tools skill
export async function addWorkIqServersToAgent(
  agent: Agent,
  authorization: Authorization,
  authHandlerName: string,
  turnContext: TurnContext
): Promise<void> {
  const servers = loadConfiguredServers();
  const tokens = new Map<string, string>();
  const mcpServers: MCPServerStreamableHttp[] = [];

  for (const server of servers) {
    const scope = resolveWorkIqTokenScope(server);
    let token = tokens.get(scope);
    if (!token) {
      token = await getServerToken(server, authorization, authHandlerName, turnContext);
      tokens.set(scope, token);
    }

    const headers = {
      ...server.headers,
      ...Utility.GetToolRequestHeaders(token, turnContext, { orchestratorName: 'OpenAI' }),
    };
    mcpServers.push(
      new MCPServerStreamableHttp({
        url: server.url,
        name: server.mcpServerName,
        requestInit: { headers },
      })
    );
  }

  agent.mcpServers = agent.mcpServers ?? [];
  agent.mcpServers.push(...mcpServers);
}
