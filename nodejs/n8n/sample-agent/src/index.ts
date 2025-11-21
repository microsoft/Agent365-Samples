// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Response } from 'express';
import 'dotenv/config';
import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import { observabilityManager } from './telemetry';
import { agentApplication } from './agent';

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();
const adapter = agentApplication.adapter as CloudAdapter;
const app = express();
const port = process.env.PORT ?? 3978;

// Middleware
app.use(express.json());
app.use(authorizeJWT(authConfig));

observabilityManager.start();

app.post('/api/messages', async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => {
    const app = agentApplication;
    await app.run(context);
  });
});

const server = app.listen(port, () => {
  console.log(`\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${!!process.env.DEBUG}`);
}).on('error', async (err) => {
  console.error(err);
  await observabilityManager.shutdown();
  process.exit(1);
}).on('close', async () => {
  console.log('observabilityManager is shutting down...');
  await observabilityManager.shutdown();
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
