// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
import { configDotenv } from 'dotenv';
configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express';
import { agentApplication } from './agent';
import { initializeObservability } from '../shared/observability';
import { handleExecutorRequest } from './handler';

initializeObservability('Multi-Agent Executor');

// Only NODE_ENV=development explicitly disables authentication
const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();

console.log(`[Executor] Environment: NODE_ENV=${process.env.NODE_ENV}, isDevelopment=${isDevelopment}`);

const server = express();
server.use(express.json());

// Health endpoint — placed BEFORE auth middleware so it doesn't require authentication
server.get('/api/health', (_req, res: Response) => {
  res.status(200).json({ status: 'healthy', service: 'executor', timestamp: new Date().toISOString() });
});

// Pipeline endpoint — placed BEFORE auth middleware (internal orchestrator calls)
server.post('/api/run', async (req: express.Request, res: Response) => {
  try {
    const result = await handleExecutorRequest(req.body, req.headers);
    res.json({ runId: req.body.runId, step: req.body.step, result });
  } catch (error) {
    console.error('[Executor] Error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

server.use(authorizeJWT(authConfig));

// Bot Framework endpoint — for Teams / Copilot Studio deployment
server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.EXECUTOR_PORT) || 4002;
const host = process.env.AGENT_HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');
server.listen(port, host, () => {
  console.log(`[Executor] listening on ${host}:${port} for appId ${authConfig.clientId}`);
}).on('error', (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', () => {
  console.log('[Executor] Server closed');
  process.exit(0);
});
