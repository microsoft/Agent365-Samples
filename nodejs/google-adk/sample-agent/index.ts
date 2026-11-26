// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Entry point — OpenTelemetry instrumentation MUST be imported first so it can
 * patch libraries (HTTP, Express, etc.) before they are loaded.
 */
import { configureObservabilityHosting } from './instrumentation';
// A365 Observability — best-effort instrumentation (verify against official sample)
import { shutdownMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';

import express, { Request, Response, NextFunction } from 'express';

import { MyAgent } from './hosting';
import { GoogleADKAgent } from './agent';
import {
  AuthConfiguration,
  authorizeJWT,
  loadAuthConfigFromEnv,
} from '@microsoft/agents-hosting';

const logger = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), 'INFO', 'main:', ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), 'WARN', 'main:', ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), 'ERROR', 'main:', ...args),
};

export function startServer(agentApp: MyAgent) {
  const isProduction =
    Boolean(process.env.WEBSITE_SITE_NAME) ||
    process.env.NODE_ENV === 'production';
  const allowAnonymous = !isProduction && process.env.NODE_ENV === 'development';

  // Always load auth config from env — needed for JWT validation even in dev
  // when using devtunnel. Bot Framework sends signed JWTs regardless of environment.
  let authConfig: AuthConfiguration = {};
  try {
    authConfig = loadAuthConfigFromEnv();
  } catch (error) {
    if (!allowAnonymous) throw error;
    logger.warn('Local development auth configuration unavailable; running without JWT validation');
  }
  if (!authConfig.clientId?.trim()) {
    if (!allowAnonymous) {
      throw new Error('A nonempty authentication client ID is required outside explicit local development.');
    }
    logger.warn('Anonymous access is enabled for local development only.');
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
  app.post('/api/messages', (req: Request, res: Response, next: NextFunction) => {
    const adapter = agentApp.cloudAdapter;
    void adapter.process(req, res, async (context) => {
      await agentApp.run(context);
    }).catch(next);
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    logger.error('Message request failed.', {
      category: error instanceof SyntaxError ? 'INVALID_JSON' : 'ADAPTER_REQUEST_FAILED',
    });
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: 'Unable to process the message request.' });
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

  const server = app.listen(port, host, () => {
    logger.info(`Listening on ${host}:${port}/api/messages`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async (error) => {
      try {
        if (error) throw error;
        await shutdownMicrosoftOpenTelemetry();
      } catch (error) {
        logger.error('Shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });
  return server;
}

function main(): void {
  const agentApplication = new MyAgent(new GoogleADKAgent());
  configureObservabilityHosting(agentApplication.cloudAdapter);
  startServer(agentApplication);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    logger.error('Application error:', e);
    process.exit(1);
  }
}
