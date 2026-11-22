// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import './otel'; // Configure S2S export before SDK and HTTP modules load.

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();

const server = express()
server.use(express.json())
server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = process.env.PORT || 3978
server.listen(port, async () => {
  console.log(`\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
}).on('error', async (err) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Server closed');
  process.exit(0);
});