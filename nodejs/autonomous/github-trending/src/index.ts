// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

import express, { Response, Request } from 'express';

import {
  ObservabilityManager,
  Builder,
  AgentDetails,
  Agent365ExporterOptions,
} from '@microsoft/agents-a365-observability';

import { tokenResolver } from './token-cache';
import { startTokenService } from './observability-token-service';
import { startHeartbeatService } from './heartbeat-service';
import { startTrendingService } from './github-trending-service';

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
  return [TENANT_ID, AGENT_ID, CLIENT_ID, CLIENT_SECRET]
    .every(v => v && !v.startsWith('<<'));
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

const a365Observability = ObservabilityManager.configure((builder: Builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  exporterOptions.maxQueueSize = 10;

  builder
    .withService('TypeScript GitHub Trending Agent', '1.0.0')
    .withExporterOptions(exporterOptions)
    .withTokenResolver(tokenResolver);
});

a365Observability.start();

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
  if (A365_ENABLED) {
    startTokenService({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      blueprintClientId: CLIENT_ID,
      blueprintClientSecret: CLIENT_SECRET,
      useManagedIdentity: USE_MANAGED_IDENTITY,
    });
  } else {
    console.warn(
      'Agent365 credentials not configured — skipping token service. ' +
      "Run 'a365 setup all' to enable A365 observability export."
    );
  }

  startHeartbeatService(HEARTBEAT_INTERVAL_MS);

  startTrendingService({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: AZURE_OPENAI_API_KEY,
    deployment: AZURE_OPENAI_DEPLOYMENT,
    agentDetails,
    language: LANGUAGE,
    minStars: MIN_STARS,
    maxResults: MAX_RESULTS,
    intervalMs: HEARTBEAT_INTERVAL_MS,
  });
}).on('error', (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', () => {
  console.log('Server closed');
  process.exit(0);
});
