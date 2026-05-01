// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

// Initialize Microsoft OpenTelemetry distro for observability.
// Must be called before importing other modules so instrumentations can patch libraries.
// See: https://github.com/microsoft/opentelemetry-distro-javascript
import { useMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';
import { tokenResolver } from './token-cache';
import { AgenticTokenCacheInstance } from '@microsoft/opentelemetry';

useMicrosoftOpenTelemetry({
  a365: {
    enabled: true,
    tokenResolver: process.env.Use_Custom_Resolver === 'true'
      ? (agentId: string, tenantId: string) => tokenResolver(agentId, tenantId) ?? ''
      : (agentId: string, tenantId: string) => AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? '',
  },
  enableConsoleExporters: true,
  instrumentationOptions: {
    openaiAgents: { enabled: true },
    langchain: { enabled: false },
  },
});

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

// Use request validation middleware only if hosting publicly
const isProduction = Boolean(process.env.WEBSITE_SITE_NAME) || process.env.NODE_ENV === 'production';
const authConfig: AuthConfiguration = isProduction ? loadAuthConfigFromEnv() : {};

const server = express()
server.use(express.json())

// Health endpoint - placed BEFORE auth middleware so it doesn't require authentication
server.get('/api/health', (req, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = Number(process.env.PORT) || 3978
const host = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, async () => {
  console.log(`\nServer listening on http://${host}:${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
}).on('error', async (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Server closed');
  process.exit(0);
});