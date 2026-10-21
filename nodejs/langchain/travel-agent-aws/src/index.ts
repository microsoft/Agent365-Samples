// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
configDotenv();

// A365 Observability — best-effort instrumentation (verify against official sample)
// A365 auth mode: agentic-user
import {
  useMicrosoftOpenTelemetry,
  AgenticTokenCacheInstance,
} from '@microsoft/opentelemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';

useMicrosoftOpenTelemetry({
  enableConsoleExporters: process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME,
  resource: resourceFromAttributes({
    'service.name': process.env.agent365Observability__agentName ?? 'TravelTeammate',
  }),
  a365: {
    enabled: true,
    enableObservabilityExporter: process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === 'true',
    tokenResolver: (agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? '',
  },
  instrumentationOptions: { langchain: {} },
});

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request,
} from '@microsoft/agents-hosting';
import express, { Response, Express } from 'express';
import { agentApplication } from './agent.js';
import { configureA365Hosting } from '@microsoft/opentelemetry';

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();

const adapter = agentApplication.adapter as CloudAdapter;

// A365 Observability — best-effort instrumentation
configureA365Hosting(adapter as any, {
  enableBaggage: true,
  enableOutputLogging: true,
});

adapter.onTurnError = async (context, err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : JSON.stringify(err);
  console.error('[onTurnError]', msg);
  try {
    await context.sendActivity(
      `Sorry — I hit an error processing that message. ${err instanceof Error ? err.message : ''}`
    );
  } catch (sendErr) {
    console.error('[onTurnError] sendActivity failed:', sendErr);
  }
};

const server: Express = express();
server.use(express.json());

// Health check — unauthenticated, must be BEFORE authorizeJWT middleware
server.get('/api/health', (_req, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Local-only test endpoint (no auth) — remove before production
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ENDPOINT === 'true') {
  server.post('/api/test-invoke', async (_req, res: Response) => {
    try {
      const { getClient } = await import('./client.js');
      // Create a minimal mock — just test LLM invoke + response parsing
      const mockAuth = {} as any;
      const mockTurnContext = {
        activity: {
          conversation: { id: 'test', tenantId: '00000000-0000-0000-0000-000000000000' },
          from: { id: 'test', name: 'Test' },
          recipient: { id: 'bot', name: 'Bot' },
        },
      } as any;
      console.log('[Test] Creating client...');
      const client = await getClient(mockAuth, 'auth', mockTurnContext, 'Test');
      const prompt = _req.body?.prompt || 'Search for 3 hotels in Paris from June 1 to June 5, 2026';
      console.log(`[Test] Invoking LLM with prompt: ${prompt.slice(0, 80)}`);
      const response = await client.invoke(prompt);
      console.log(`[Test] Response (${response?.length} chars): ${response?.slice(0, 200)}`);
      res.json({ success: true, response: response?.slice(0, 500) });
    } catch (err: any) {
      console.error('[Test] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

server.use(authorizeJWT(authConfig));

server.post('/api/messages', async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { type?: string; text?: string; from?: { name?: string } };
  console.log(
    `[/api/messages] ${req.method} type=${b.type} from=${b.from?.name} text=${(b.text ?? '')
      .toString()
      .slice(0, 60)}`
  );
  try {
    await adapter.process(req, res, async (context) => {
      await agentApplication.run(context);
    });
  } catch (err) {
    console.error('[/api/messages] outer catch:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// AWS Lambda Web Functions hands the server its listen address as "host:port" in
// AWS_LAMBDA_HTTP_ENDPOINT; requests never reach a server listening anywhere else.
const lambdaEndpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
const lambdaSep = lambdaEndpoint ? lambdaEndpoint.lastIndexOf(':') : -1;
const port = Number(lambdaSep > 0 ? lambdaEndpoint!.slice(lambdaSep + 1) : process.env.PORT) || 3978;
// Azure App Service (and any cloud host) sets WEBSITE_SITE_NAME and routes traffic
// to the app through a front-end proxy — the app MUST listen on 0.0.0.0, not loopback,
// or every request 502s. Locally we keep 127.0.0.1.
const isProduction = Boolean(process.env.WEBSITE_SITE_NAME) || process.env.NODE_ENV === 'production';
const host = lambdaSep > 0 ? lambdaEndpoint!.slice(0, lambdaSep) : isProduction ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  console.log(
    `\nServer listening on http://${host}:${port} ` +
    `for appId ${authConfig.clientId} debug ${process.env.DEBUG}`
  );
}).on('error', (err) => {
  console.error(err);
  process.exit(1);
});
