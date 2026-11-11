// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CopilotClient, ToolSet, type CopilotSession, type SessionConfig,
} from '@github/copilot-sdk';
import { RUNTIME_VERSION, runtimeEnvironment, type SampleConfig } from './config.js';
import { createTools } from './tools.js';
import type { InvocationTelemetry, SampleTelemetry } from './telemetry.js';

export function createClient(env: NodeJS.ProcessEnv = process.env): CopilotClient {
  if (env.COPILOT_CLI_PATH) throw new Error('Unset COPILOT_CLI_PATH to use the pinned bundled runtime');
  const token = env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  return new CopilotClient({
    mode: 'empty',
    env: runtimeEnvironment(env),
    ...(token ? { baseDirectory: resolve(env.COPILOT_SAMPLE_HOME || '.copilot-local') } : {}),
    ...(token ? { gitHubToken: token, useLoggedInUser: false } : { useLoggedInUser: true }),
    logLevel: 'error',
    enableRemoteSessions: false,
  });
}

export function sessionConfig(
  config: SampleConfig, events: InvocationTelemetry,
): SessionConfig {
  return {
    sessionId: events.sessionId,
    model: config.model,
    tools: createTools(events),
    availableTools: new ToolSet().addCustom('add_numbers').addCustom('fail_deliberately'),
    onPermissionRequest: () => ({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' }),
    enableConfigDiscovery: false,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    remoteSession: 'off',
    mcpServers: {},
    customAgents: [],
    infiniteSessions: { enabled: false },
    systemMessage: {
      mode: 'replace',
      content: 'You are a standalone arithmetic demonstration agent. Use add_numbers for addition. ' +
        'Call fail_deliberately only when explicitly requested. Report tool failures honestly. ' +
        'Never claim Agent 365 delivery or cloud registration. You have no filesystem, shell, or network tools.',
    },
    onEvent: event => events.onEvent(event),
  };
}

export interface RuntimeClient {
  start(): Promise<void>;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  createSession(config: SessionConfig): Promise<Pick<CopilotSession, 'sendAndWait' | 'disconnect' | 'abort'>>;
  stop(): Promise<Error[]>;
}

export async function runtimeStatus(client: RuntimeClient) {
  await client.start();
  const status = await client.getStatus();
  if (status.version !== RUNTIME_VERSION) throw new Error('Runtime version does not match the pinned SDK runtime');
  const auth = await client.getAuthStatus();
  return { ...status, isAuthenticated: auth.isAuthenticated };
}

export async function runCopilot(
  config: SampleConfig,
  telemetry: SampleTelemetry,
  prompt: string,
  client: RuntimeClient = createClient(),
): Promise<string> {
  try {
    const status = await runtimeStatus(client);
    if (!status.isAuthenticated) {
      throw new Error('Copilot is not authenticated; provide an eligible GitHub token or existing CLI login');
    }
    return await telemetry.invoke(randomUUID(), async events => {
      let session: Awaited<ReturnType<RuntimeClient['createSession']>> | undefined;
      try {
        session = await client.createSession(sessionConfig(config, events));
        const response = await session.sendAndWait({ prompt }, config.timeoutMs);
        events.assertSessionHealthy();
        if (!response) throw new Error('Copilot returned no assistant response');
        return response.data.content;
      } catch (error) {
        if (session) await session.abort();
        throw error;
      } finally {
        if (session) await session.disconnect();
      }
    });
  } finally {
    const errors = await client.stop();
    if (errors.length) throw new Error('Copilot runtime cleanup failed');
  }
}
