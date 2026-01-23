// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Note: dotenv is loaded in agent.ts before AgentApplication is instantiated

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

// Use request validation middleware only if hosting publicly
const isProduction = Boolean(process.env.WEBSITE_SITE_NAME) || process.env.NODE_ENV === 'production';
const authConfig: AuthConfiguration = isProduction ? loadAuthConfigFromEnv() : {};

const server = express()
server.use(express.json())
server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = Number(process.env.PORT) || 3978
const host = isProduction ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, async () => {
  console.log(`\nServer listening on ${host}:${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
}).on('error', async (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Server closed');
  process.exit(0);
});