// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// HTTP host for the agent. index.ts loads this module only after telemetry is registered.
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
import { isAgentsChannel, turnCorrelationId } from './activity-helpers.js';
import { logError } from './log.js';

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();

const adapter = agentApplication.adapter as CloudAdapter;

// A365 Observability: turn baggage plus OutputLoggingMiddleware, which links outbound messages
// to the turn's InvokeAgentScope (agent.ts sets A365ParentSpanId).
configureA365Hosting(adapter as any, {
  enableBaggage: true,
  enableOutputLogging: true,
});

// Full error detail stays in the server log under a correlation id; the user only gets the id.
adapter.onTurnError = async (context, err) => {
  const correlationId = turnCorrelationId(context.activity);
  logError(`[onTurnError] correlationId=${correlationId}`, err);
  // The agents channel (Word/notification turns) rejects replies, so nothing is sent there.
  if (isAgentsChannel(context.activity)) return;
  try {
    await context.sendActivity(`Sorry — I hit an error processing that message. Reference: ${correlationId}`);
  } catch (sendErr) {
    logError('[onTurnError] sendActivity failed:', sendErr);
  }
};

const server: Express = express();
server.use(express.json());

// Health check — unauthenticated, must be BEFORE authorizeJWT middleware
server.get('/api/health', (_req, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

server.use(authorizeJWT(authConfig));

server.post('/api/messages', async (req: Request, res: Response) => {
  // Shapes only — no message text or sender names in the logs.
  const b = (req.body ?? {}) as { type?: string; channelId?: string; text?: string };
  console.log(
    `[/api/messages] ${req.method} type=${b.type} channel=${b.channelId} textLength=${(b.text ?? '').toString().length}`
  );
  try {
    await adapter.process(req, res, async (context) => {
      await agentApplication.run(context);
    });
  } catch (err) {
    logError('[/api/messages] outer catch:', err);
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
