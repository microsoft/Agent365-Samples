// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

import express, { Response, Request } from 'express';

import {
  useMicrosoftOpenTelemetry,
  shutdownMicrosoftOpenTelemetry,
} from '@microsoft/opentelemetry';
import type { AgentDetails } from '@microsoft/opentelemetry';

import { tokenResolver } from './token-cache';
import { startTokenService } from './observability-token-service';
import { startHeartbeatService } from './heartbeat-service';
import { startTrendingService } from './github-trending-service';

// Track interval/controller handles for graceful shutdown
const shutdownHandles: { intervals: ReturnType<typeof setInterval>[]; controllers: AbortController[] } = {
  intervals: [],
  controllers: [],
};

// ── Configuration ────────────────────────────────────────────────────────────

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT!;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY!;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

// Agent 365 Observability — optional. When these are missing or set to placeholders,
// the agent runs without A365 observability export (spans go to console only).
const TENANT_ID = process.env.AGENT365_TENANT_ID || '';
const AGENT_ID = process.env.AGENT365_AGENT_ID || '';
const BLUEPRINT_ID = process.env.AGENT365_BLUEPRINT_ID || '';
const CLIENT_ID = process.env.AGENT365_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AGENT365_CLIENT_SECRET || '';
const AGENT_NAME = process.env.AGENT365_AGENT_NAME || 'github-trending';
const AGENT_DESCRIPTION = process.env.AGENT365_AGENT_DESCRIPTION || '';
const USE_MANAGED_IDENTITY = (process.env.AGENT365_USE_MANAGED_IDENTITY || 'true').toLowerCase() === 'true';

function hasA365Credentials(): boolean {
  const requiredValues = [TENANT_ID, AGENT_ID, CLIENT_ID];
  const hasRequiredValues = requiredValues.every(v => v && !v.startsWith('<<'));

  if (!hasRequiredValues) {
    return false;
  }

  if (USE_MANAGED_IDENTITY) {
    return true;
  }

  return !!CLIENT_SECRET && !CLIENT_SECRET.startsWith('<<');
}

const A365_ENABLED = hasA365Credentials();

const LANGUAGE = process.env.GITHUB_TRENDING_LANGUAGE || 'typescript';
const MIN_STARS = parseInt(process.env.GITHUB_TRENDING_MIN_STARS || '5', 10);
const MAX_RESULTS = parseInt(process.env.GITHUB_TRENDING_MAX_RESULTS || '10', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const PORT = parseInt(process.env.PORT || '3979', 10);

const isDevelopment = process.env.NODE_ENV === 'development';

// ── Agent Details (shared across all scopes) ─────────────────────────────────

const agentDetails: AgentDetails = {
  agentId: AGENT_ID || 'local-dev',
  agentName: AGENT_NAME,
  agentDescription: AGENT_DESCRIPTION,
  agentBlueprintId: BLUEPRINT_ID,
  tenantId: TENANT_ID || 'local-dev',
};

// ── Observability ────────────────────────────────────────────────────────────
// Configure Microsoft OpenTelemetry distro with A365 exporter.
// Token resolver reads from the in-memory cache populated by the background token service.

useMicrosoftOpenTelemetry({
  a365: A365_ENABLED
    ? {
        enabled: true,
        tokenResolver: (agentId, tenantId) => tokenResolver(agentId, tenantId) ?? '',
      }
    : undefined,
});

// ── Express server ───────────────────────────────────────────────────────────

const server = express();
server.use(express.json());

server.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

server.get('/', (_req: Request, res: Response) => {
  res.send('GitHubTrending — Autonomous agent monitoring trending repositories');
});

const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');
server.listen(PORT, host, () => {
  console.log(`\nServer listening on ${host}:${PORT} (NODE_ENV=${process.env.NODE_ENV})`);

  // Start background services after server is listening.
  // Token service is skipped when Agent 365 credentials are not configured.
  let tokenServiceDelayMs = 0;
  if (A365_ENABLED) {
    const tokenInterval = startTokenService({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      blueprintClientId: CLIENT_ID,
      blueprintClientSecret: CLIENT_SECRET,
      useManagedIdentity: USE_MANAGED_IDENTITY,
    });
    shutdownHandles.intervals.push(tokenInterval);
    // Give the token service time to cache the first token before the first LLM cycle
    tokenServiceDelayMs = 10_000;
  } else {
    console.warn(
      'Agent365 credentials not configured — skipping token service. ' +
      "Run 'a365 setup all' to enable A365 observability export."
    );
  }

  shutdownHandles.intervals.push(startHeartbeatService(HEARTBEAT_INTERVAL_MS));

  const trendingController = startTrendingService({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: AZURE_OPENAI_API_KEY,
    deployment: AZURE_OPENAI_DEPLOYMENT,
    agentDetails,
    language: LANGUAGE,
    minStars: MIN_STARS,
    maxResults: MAX_RESULTS,
    intervalMs: HEARTBEAT_INTERVAL_MS,
  }, tokenServiceDelayMs);
  shutdownHandles.controllers.push(trendingController);
}).on('error', (err: unknown) => {
  console.error(err);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  for (const interval of shutdownHandles.intervals) {
    clearInterval(interval);
  }
  for (const controller of shutdownHandles.controllers) {
    controller.abort();
  }
  shutdownMicrosoftOpenTelemetry().finally(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
