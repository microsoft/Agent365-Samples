// It is important to load environment variables before importing other modules
import { configDotenv } from 'dotenv';

configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express';
import { agentApplication } from './agent';

const authConfig: AuthConfiguration = {};
const adapter = new CloudAdapter(authConfig);

const app = express();
app.use(express.json());
app.use(authorizeJWT(authConfig));

app.post('/api/messages', async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = process.env.PORT || 3978;
const server = app.listen(port, () => {
  console.log(`\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`);
}).on('error', async (err) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Kairo is shutting down...');
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});