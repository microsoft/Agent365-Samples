import express from 'express';
import { CloudAdapter, authorizeJWT, loadAuthConfigFromEnv } from '@microsoft/agents-hosting';
import { simpleClaudeAgent } from './agent.js';
import { observabilityManager } from './telemetry.js';

console.log('🚀 Starting Simple Claude Agent...');
console.log('   Claude Code SDK + Microsoft 365 Agents SDK');
console.log('   Access at: http://localhost:3978');
console.log('');

const authConfig = {};
const adapter = new CloudAdapter();

const app = express();
app.use(express.json());
app.use(authorizeJWT(authConfig));

observabilityManager.start();

app.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, async (context) => {
    await simpleClaudeAgent.run(context);
  });
});

const port = process.env.PORT || 3978;
const server = app.listen(port, () => {
  console.log(`Server listening to port ${port} on sdk 1.0.15 for debug ${process.env.DEBUG}`);
});

server.on('error', async (err) => {
	console.error(err);
	await observabilityManager.shutdown();
	process.exit(1);
}).on('close', async () => {
	console.log('Observability Manager is shutting down...');
	await observabilityManager.shutdown();
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
