// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Entry point — OpenTelemetry instrumentation MUST be imported first so it can
 * patch libraries (HTTP, Express, etc.) before they are loaded.
 */
import './instrumentation';

import express, { Request, Response } from 'express';

import { MyAgent } from './hosting';
import { GoogleADKAgent } from './agent';
import {
  AuthConfiguration,
  authorizeJWT,
  loadAuthConfigFromEnv,
  CloudAdapter,
} from '@microsoft/agents-hosting';

const logger = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), 'INFO', 'main:', ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), 'WARN', 'main:', ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), 'ERROR', 'main:', ...args),
};

function startServer(agentApp: MyAgent): void {
  const isProduction =
    Boolean(process.env.WEBSITE_SITE_NAME) ||
    process.env.NODE_ENV === 'production';

  // Always load auth config from env — needed for JWT validation even in dev
  // when using devtunnel. Bot Framework sends signed JWTs regardless of environment.
  let authConfig: AuthConfiguration = {};
  try {
    authConfig = loadAuthConfigFromEnv();
  } catch {
    logger.info('No auth credentials found — running without JWT validation');
  }

  const app = express();
  app.use(express.json());

  // --- Health / readiness endpoints — placed BEFORE auth middleware ---
  const healthHandler = (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      agentType: 'GoogleADKAgent',
      agentInitialized: true,
      timestamp: new Date().toISOString(),
    });
  };

  app.get('/', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/robots933456.txt', (_req: Request, res: Response) => {
    res.status(200).send('OK');
  });

  // --- JWT authorization middleware (applies to all routes after this) ---
  app.use(authorizeJWT(authConfig));

  // --- Main agent endpoint ---
  app.post('/api/messages', (req: Request, res: Response) => {
    const adapter = agentApp.cloudAdapter as CloudAdapter;
    adapter.process(req, res, async (context) => {
      await agentApp.run(context);
    });
  });

  // --- Determine host and port ---
  const host = isProduction ? '0.0.0.0' : 'localhost';
  const portStr = process.env.PORT;
  let port = 3978;

  if (portStr) {
    const parsed = parseInt(portStr, 10);
    if (isNaN(parsed)) {
      logger.warn(`Invalid PORT value '${portStr}', using default 3978`);
    } else {
      port = parsed;
      logger.info(`Using PORT from environment: ${port}`);
    }
  } else {
    logger.info(`PORT not set, using default: ${port}`);
  }

  console.log('='.repeat(80));
  console.log('Google ADK Sample Agent (Node.js)');
  console.log('='.repeat(80));
  console.log(`Auth:     ${authConfig.clientId ? 'JWT Enabled' : 'Anonymous (no credentials)'}`);
  console.log(`Server:   ${host}:${port}`);
  console.log(`Endpoint: http://${host}:${port}/api/messages`);
  console.log(`Health:   http://${host}:${port}/api/health`);
  console.log(`AppId:    ${authConfig.clientId ?? '(none)'}`);
  console.log(`Env:      ${isProduction ? 'production' : 'development'}`);
  console.log();

  app.listen(port, host, () => {
    logger.info(`Listening on ${host}:${port}/api/messages`);
  });
}

function main(): void {
  const agentApplication = new MyAgent(new GoogleADKAgent());
  startServer(agentApplication);
}

try {
  main();
} catch (e) {
  logger.error('Application error:', e);
  process.exit(1);
}
