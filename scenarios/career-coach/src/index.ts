// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

// A365 Observability — best-effort instrumentation (verify against official sample)
// Initialize the Microsoft OpenTelemetry distro before the agent/LLM modules load.
import { setObservabilityConnection } from './telemetry';

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';
import { portalSecretProblem } from './portal-secret';
import { setBackgroundTokenProvider } from './graph-service';
import { onAgentIdentityChange } from './agent-identity';
import { retrySubscriptionNow } from './subscription-manager';
import { PortalQueue } from './portal-notifications';
import * as path from 'path';

// The observability token resolver mints app-only export tokens from the hosting connection
// (the blueprint credential), so hand it the adapter's default connection.
setObservabilityConnection(() => (agentApplication.adapter as CloudAdapter).connectionManager.getDefaultConnection());

// Background Graph work (the change subscription and the notification row scan) has no user turn:
// it mints the agent user's token from the same connection with getAgenticUserToken(...), using the
// agent identity captured from the first message (or AGENT_INSTANCE_ID / AGENT_USER_ID).
setBackgroundTokenProvider({
  getAgenticUserToken: (tenantId, agentInstanceId, agenticUserId, scopes) =>
    (agentApplication.adapter as CloudAdapter).connectionManager.getDefaultConnection()
      .getAgenticUserToken(tenantId, agentInstanceId, agenticUserId, scopes),
});
onAgentIdentityChange(() => retrySubscriptionNow());

// Production with a webhook configured must not run on the developer sign-in or a weak secret.
if (process.env.NODE_ENV === 'production' && (process.env.PORTAL_WEBHOOK_URL || '').trim()) {
  const problems: string[] = [];
  const secretProblem = portalSecretProblem();
  if (secretProblem) problems.push(secretProblem);
  if (!process.env.connections__service_connection__settings__clientId || !process.env.connections__service_connection__settings__clientSecret) {
    problems.push('the service connection (clientId/clientSecret) is not configured, so the agent identity cannot mint the background Graph token');
  }
  if (problems.length) {
    console.error(`[startup] PORTAL_WEBHOOK_URL is set but the agent cannot run the portal trigger safely: ${problems.join('; ')}.`);
    process.exit(1);
  }
}

// Safety net: background activities (e.g. typing indicators, replies to system
// notifications) can reject asynchronously. Without these guards a single 502 from
// the connector would crash the whole process and stop the agent from responding.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, server stays up):', (reason as any)?.message ?? reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception; terminating process:', err?.message ?? err);
  process.exit(1);
});

// Only NODE_ENV=development explicitly disables authentication
// All other cases (production, test, unset, etc.) require authentication
const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();

console.log(`Environment: NODE_ENV=${process.env.NODE_ENV}, isDevelopment=${isDevelopment}`);

const server = express()
server.use(express.json())

// TEMPORARY diagnostic logger — logs every inbound request before any auth/route
// matching, so we can see whether Teams/A365 is reaching this endpoint at all.
server.use((req, _res, next) => {
  const auth = req.headers['authorization'] ? 'auth=yes' : 'auth=no';
  console.log(`[req] ${req.method} ${req.url} ${auth} ua="${req.headers['user-agent'] ?? ''}"`);
  next();
});

// Health endpoint - placed BEFORE auth middleware so it doesn't require authentication
server.get('/api/health', (req, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Feature 1 (real trigger): Microsoft Graph change-notification subscription on the
// `LearningPortalStatus` SharePoint list POSTs here whenever a row is created or updated.
// We also accept a manual JSON body ({ UserAADId, ... }) protected by the shared secret,
// so we can test the flow end-to-end without waiting for Graph latency.
//
// Three request shapes are accepted:
//   (a) Graph validation handshake: POST ?validationToken=<x> with any body.
//       Response: 200 text/plain, body = <x>. Must complete within ~10s.
//   (b) Graph notification: JSON body = { value: [{ subscriptionId, clientState, resource, ... }, ...] }
//       Response: 202. clientState in each entry MUST equal PORTAL_EVENT_SECRET.
//   (c) Manual (curl / Invoke-RestMethod): JSON body = { UserAADId, CourseId?, ... }
//       Header X-Portal-Secret: <PORTAL_EVENT_SECRET>. Fires a proactive DM immediately.
//
// Placed BEFORE authorizeJWT because Graph and manual callers don't produce an A365 JWT.
server.post('/api/portal-event', async (req: Request, res: Response) => {
  // -------- (a) Graph validation handshake --------
  const validationToken = String((req as any)?.query?.validationToken || '').trim();
  if (validationToken) {
    console.log('[Proactive] Graph validation handshake — replying with token.');
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(validationToken);
    return;
  }

  const secretProblem = portalSecretProblem();
  if (secretProblem) {
    console.error(`[Proactive] ${secretProblem} — refusing the request.`);
    res.status(500).json({ ok: false, reason: 'PORTAL_EVENT_SECRET is not configured with a strong value on the agent.' });
    return;
  }
  const expected = String(process.env.PORTAL_EVENT_SECRET).trim();

  const body = (req.body || {}) as any;

  // -------- (b) Graph change notification --------
  if (Array.isArray(body?.value)) {
    // Verify clientState on the first entry. All entries should have the same clientState
    // for a given subscription, so checking one is sufficient.
    const first = body.value[0] ?? {};
    if (!first.clientState || first.clientState !== expected) {
       console.warn('[Proactive] Graph notification with missing/bad clientState — rejecting.');
      res.status(401).json({ ok: false, reason: 'clientState mismatch.' });
      return;
    }
    // Record the work durably BEFORE acknowledging: Graph treats the 202 as delivered and won't resend,
    // so from here the queue (with its own retry) owns the notification.
    portalQueue.enqueue();
    res.status(202).json({ ok: true });
    console.log(`[Proactive] Graph notification received — ${body.value.length} entries.`);
    void portalQueue.kick().catch((err) => {
      console.error('[Proactive] Processing the portal notification queue failed:', (err as any)?.message ?? err);
    });
    return;
  }

  // -------- (c) Manual / test path --------
  const provided = String(req.headers['x-portal-secret'] || '');
  if (provided !== expected) {
    console.warn('[Proactive] /api/portal-event received with bad or missing X-Portal-Secret header.');
    res.status(401).json({ ok: false, reason: 'Bad or missing X-Portal-Secret.' });
    return;
  }
  const aad = String(body.UserAADId || '').trim();
  if (!aad) {
    res.status(400).json({ ok: false, reason: 'Body must include UserAADId (or a Graph "value" array).' });
    return;
  }
  const result = await agentApplication.handleProactivePortalEvent(aad, body);
  res.status(result.ok ? 200 : 202).json(result);
});

/**
 * Graph change notifications are queued durably BEFORE they are acknowledged and processed with bounded
 * retry (see portal-notifications.ts), so a Graph / Teams outage right after the 202 can't lose the
 * final course-completion update. Each pass reads the recently-updated LearningPortalStatus rows
 * (list subscriptions only say "something changed") and DMs each affected user once per change.
 */
async function readRecentPortalRows(cutoffMs: number): Promise<Array<{ id: string; fields: Record<string, any> }>> {
  const { getSiteId, getListIdByName, getListItems, getBackgroundGraphClient } = await import('./graph-service');
  const { SP_CONFIG } = await import('./career-coach-types');
  const graph = getBackgroundGraphClient();
  const siteId = await getSiteId(graph);
  const listId = await getListIdByName(siteId, SP_CONFIG.lists.learningPortalStatus, graph);
  if (!listId) throw new Error('LearningPortalStatus list not found — cannot process the notification.');
  // Read only recently-changed rows (server-side filter on LastUpdated); fall back to a full
  // scan if the filter is rejected so a notification is never silently dropped.
  try {
    const { getColumnMap } = await import('./sharepoint-column-map');
    const colMap = await getColumnMap(graph, siteId, listId);
    const lastUpdatedCol = colMap.displayToInternal['LastUpdated'] ?? 'LastUpdated';
    return await getListItems(siteId, listId, { graph, filter: `fields/${lastUpdatedCol} ge '${new Date(cutoffMs).toISOString()}'` });
  } catch (filterErr) {
    console.warn('[Proactive] Filtered read failed, falling back to a full scan:', (filterErr as any)?.message ?? filterErr);
    return await getListItems(siteId, listId, { graph });
  }
}

const portalQueue = new PortalQueue({
  filePath: path.resolve(process.cwd(), '.portal-queue.json'),
  scan: readRecentPortalRows,
  deliver: (aad, fields) => agentApplication.handleProactivePortalEvent(aad, {
    UserAADId: aad,
    CourseId: fields.CourseId,
    Status: fields.Status,
    PercentComplete: fields.PercentComplete,
    TimeSpentMinutes: fields.TimeSpentMinutes,
  }),
});

server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = Number(process.env.PORT) || 3978
// Host is configurable; default to localhost for development, 0.0.0.0 for everything else
const host = process.env.HOST ?? (isDevelopment ? 'localhost' : '0.0.0.0');
server.listen(port, host, async () => {
  console.log(`\nServer listening on ${host}:${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
  // A notification that was acknowledged but not fully processed before a restart is picked up again.
  if (portalQueue.hasPending()) {
    console.log('[startup] Resuming portal notifications that were still pending.');
    void portalQueue.kick().catch((err) => console.error('[startup] Resuming portal notifications failed:', (err as any)?.message ?? err));
  }
  // Real-time trigger for Feature 1: ensure a Microsoft Graph change-notification subscription
  // exists on the LearningPortalStatus list, pointing at our /api/portal-event endpoint.
  // Best-effort — a failed attempt (agent identity not known until the first message, tunnel down)
  // does NOT stop the agent: ensureSubscription retries with backoff, and the manual POST path
  // still works for testing.
  try {
    const { ensureSubscription } = await import('./subscription-manager');
    await ensureSubscription();
  } catch (err) {
    console.warn('[startup] ensureSubscription failed (non-fatal):', (err as any)?.message ?? err);
  }

  // Warm the siteId cache so proactive turns don't rely on the LLM correctly
  // recalling the full composite siteId (it sometimes hallucinates plausible-looking
  // GUIDs, and the first SharePoint call fails).
  try {
    const { warmSiteCache } = await import('./sharepoint-tools');
    await warmSiteCache();
  } catch (err) {
    console.warn('[startup] warmSiteCache failed (non-fatal):', (err as any)?.message ?? err);
  }
}).on('error', async (err: unknown) => {
  console.error(err);
  process.exit(1);
}).on('close', async () => {
  console.log('Server closed');
  process.exit(0);
});
