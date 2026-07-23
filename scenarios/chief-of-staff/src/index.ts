// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports.
// override: true so .env wins over any pre-set shell vars (e.g. NODE_ENV).
import { configDotenv } from 'dotenv';
configDotenv({ override: true });

// Install global axios HTTP tracing (only active when LOG_HTTP=true).
// Must run before any module that imports axios makes a request.
import { installHttpLogging } from './util/httpLogger';
installHttpLogging();

// Print a boot-time config summary BEFORE any other imports run so misconfig
// shows up before Foundry/A365 clients start swallowing/complaining.
import { printStartupBanner } from './startup-check';
printStartupBanner();

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request,
} from '@microsoft/agents-hosting';
import express, { Response } from 'express';

import { agentApplication } from './agent';

// Always load auth config from env — Teams sends real JWTs regardless of
// NODE_ENV. `isDevelopment` only controls things like the default bind host.
const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = loadAuthConfigFromEnv();

console.log(
  `[server] NODE_ENV=${process.env.NODE_ENV}, isDevelopment=${isDevelopment}`
);

// Last-resort safety net. Without these, an unhandled rejection from the
// connector (e.g. a 502 Bad Gateway trying to send an outbound Activity, or
// the default onTurnError itself throwing) tears the whole Node process
// down — which also kills the scheduler / capture poller. Log and keep the
// server (and the cron/poll loops) alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] unhandledRejection — keeping process alive.', {
    reason: (reason as Error)?.message ?? reason,
    stack: (reason as Error)?.stack,
    promise: String(promise),
  });
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException — keeping process alive.', {
    message: err?.message,
    stack: err?.stack,
  });
});

const server = express();
server.use(express.json());

// Health probe — placed BEFORE auth middleware so it doesn't require auth.
server.get('/api/health', (_req, res: Response) => {
  res
    .status(200)
    .json({ status: 'healthy', service: 'cos-agent', timestamp: new Date().toISOString() });
});

server.use(authorizeJWT(authConfig));

// Bot Framework / Agent 365 Activity Bus endpoint.
server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = (agentApplication as unknown as { adapter: CloudAdapter }).adapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env.PORT) || 3978;
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');

server
  .listen(port, host, () => {
    console.log(`[server] listening on ${host}:${port}`);
  })
  .on('error', (err: unknown) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  })
  .on('close', () => {
    console.log('[server] closed');
    process.exit(0);
  });
