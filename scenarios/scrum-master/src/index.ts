// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

// SMA extensions
import { triggerStandup } from './handlers/standup';
import { runWarnCheck } from './handlers/warn';
import { runSprintCloseReport } from './handlers/report';
import { runSprintSummary } from './handlers/sprint-summary';
import { startLocalScheduler } from './cron/local-scheduler';
import { getInternalTriggerToken } from './config';

// Only NODE_ENV=development explicitly disables authentication
// All other cases (production, test, unset, etc.) require authentication
const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();

console.log(`Environment: NODE_ENV=${process.env.NODE_ENV}, isDevelopment=${isDevelopment}`);

const server = express()
server.use(express.json())

// Lightweight request logger: prints every incoming HTTP request so we can see
// whether Teams / A365 platform is actually reaching us via the dev tunnel.
server.use((req, _res, next) => {
  console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// Health endpoint - placed BEFORE auth middleware so it doesn't require authentication
server.get('/api/health', (req, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// SMA: internal trigger endpoints for Azure Function timers. Guarded by a shared
// secret (`INTERNAL_TRIGGER_TOKEN`) sent in the `x-internal-token` header. Placed
// BEFORE the JWT middleware because Functions call this over plain HTTP.
const internalToken = getInternalTriggerToken();
function requireInternalToken(req: express.Request, res: Response): boolean {
  const provided = req.get('x-internal-token') ?? '';
  if (!internalToken) {
    // Convention: empty token in .env => endpoint is open (dev-only). Log a warning once.
    return true;
  }
  if (provided !== internalToken) {
    res.status(401).json({ error: 'invalid internal token' });
    return false;
  }
  return true;
}

server.post('/api/internal/standup-trigger', async (req, res: Response) => {
  if (!requireInternalToken(req, res)) return;
  try {
    const result = await triggerStandup({ source: 'http' });
    res.status(200).json(result);
  } catch (e) {
    console.error('[internal] standup-trigger failed:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

server.post('/api/internal/nightly-check', async (req, res: Response) => {
  if (!requireInternalToken(req, res)) return;
  const force = String(req.query.force ?? '').toLowerCase();
  const sprintId = req.query.sprintId ? Number(req.query.sprintId) : undefined;
  // `?forceAlert=true` makes the Warn check DM the SM regardless of whether the
  // thresholds actually tripped. Handy for a demo when the sprint hasn't run
  // long enough to trip organically.
  const forceAlert = String(req.query.forceAlert ?? '').toLowerCase() === 'true';

  const result: Record<string, unknown> = { ok: true };

  // ?force=warn — run only Warn. ?force=report — run only Report.
  // Anything else (default) runs both.
  try {
    if (force !== 'report') {
      result.warn = await runWarnCheck({ forceAlert });
    }
  } catch (e) {
    result.warnError = (e as Error).message;
    console.error('[internal] warn failed:', (e as Error).message);
  }
  try {
    if (force !== 'warn') {
      const isForce = force === 'report' || force === 'both' || force === 'all';
      result.report = await runSprintCloseReport({ force: isForce, sprintId });
    }
  } catch (e) {
    result.reportError = (e as Error).message;
    console.error('[internal] report failed:', (e as Error).message);
  }

  res.status(200).json(result);
});

server.post('/api/internal/sprint-summary', async (req, res: Response) => {
  if (!requireInternalToken(req, res)) return;
  const force = String(req.query.force ?? '').toLowerCase() === 'true';
  const sprintId = req.query.sprintId ? Number(req.query.sprintId) : undefined;
  try {
    const result = await runSprintSummary({ force, sprintId });
    res.status(200).json(result);
  } catch (e) {
    console.error('[internal] sprint-summary failed:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = Number(process.env.PORT) || 3978
// Host is configurable; default to localhost for development, 0.0.0.0 for everything else
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');

// Global safety net: keep the dev server alive when a background task (SMA
// standup/reconcile/chase, MSAL token refresh, etc.) throws an uncaught error.
// Without these handlers Node 20+ exits the process on any unhandled rejection.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err.stack ?? err.message);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack ?? err.message);
});

server.listen(port, host, async () => {
  console.log(`\nServer listening on ${host}:${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
  // SMA: kick off the in-process cron (no-op when LOCAL_CRON=false).
  try {
    startLocalScheduler();
  } catch (e) {
    console.warn('[cron] Failed to start local scheduler (non-fatal):', (e as Error).message);
  }
}).on('error', async (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Server closed');
  process.exit(0);
});