// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures all config is available when packages initialize at import time
import { configDotenv } from 'dotenv';
configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

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

  const expected = process.env.PORTAL_EVENT_SECRET || '';
  if (!expected) {
    console.error('[Proactive] PORTAL_EVENT_SECRET is not set in .env — refusing the request.');
    res.status(500).json({ ok: false, reason: 'PORTAL_EVENT_SECRET not configured on the agent.' });
    return;
  }

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
    // Ack Graph FAST — it retries hard if we take too long. Do the real work async.
    res.status(202).json({ ok: true });
    // Fire-and-forget: read recently-changed rows and DM affected users.
    void handleGraphNotification(body).catch((err) => {
      console.error('[Proactive] Async Graph notification handling failed:', (err as any)?.message ?? err);
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
 * Handles a Microsoft Graph change-notification batch. Since list subscriptions only tell us
 * "something changed" without which item, we read recently-updated LearningPortalStatus rows
 * and fire a proactive DM per affected user.
 */
async function handleGraphNotification(body: { value: Array<{ resource?: string; clientState?: string; subscriptionId?: string; changeType?: string }> }): Promise<void> {
  const { getSiteId, getListIdByName, getListItems } = await import('./graph-service');
  const { SP_CONFIG } = await import('./career-coach-types');

  console.log(`[Proactive] Graph notification received — ${body.value.length} entries.`);
  // Compute the "recently updated" window: the last 10 minutes covers Graph's typical latency
  // plus a safety margin, and the LLM's Stage 4-SYNC is idempotent for users who have nothing new.
  const cutoff = new Date(Date.now() - 10 * 60_000);

  let siteId: string;
  let listId: string | null;
  try {
    siteId = await getSiteId();
    listId = await getListIdByName(siteId, SP_CONFIG.lists.learningPortalStatus);
    if (!listId) {
      console.warn('[Proactive] LearningPortalStatus list not found — cannot process notification.');
      return;
    }
  } catch (err) {
    console.error('[Proactive] Failed to resolve site/list for notification:', (err as any)?.message ?? err);
    return;
  }

  let rows: Array<{ id: string; fields: Record<string, any> }>;
  try {
    rows = await getListItems(siteId, listId);
  } catch (err) {
    console.error('[Proactive] Failed to read LearningPortalStatus rows:', (err as any)?.message ?? err);
    return;
  }

  const usersToNotify = new Map<string, any>();
  for (const row of rows) {
    const f = row.fields || {};
    const lastUpdated = f.LastUpdated ? new Date(f.LastUpdated) : null;
    if (!lastUpdated || isNaN(lastUpdated.valueOf())) continue;
    if (lastUpdated < cutoff) continue;
    const aad = String(f.UserAADId || '').trim();
    if (!aad) continue;
    // Keep the newest row per user (avoid double-DM if a user has multiple recent changes).
    const existing = usersToNotify.get(aad);
    if (!existing || new Date(existing.LastUpdated ?? 0) < lastUpdated) usersToNotify.set(aad, f);
  }

  if (usersToNotify.size === 0) {
    console.log('[Proactive] No rows changed within the last 10 min — nothing to DM.');
    return;
  }
  console.log(`[Proactive] Firing proactive DM for ${usersToNotify.size} user(s): ${Array.from(usersToNotify.keys()).join(', ')}`);
  for (const [aad, fields] of usersToNotify.entries()) {
    try {
      const result = await agentApplication.handleProactivePortalEvent(aad, {
        UserAADId: aad,
        CourseId: fields.CourseId,
        Status: fields.Status,
        PercentComplete: fields.PercentComplete,
        TimeSpentMinutes: fields.TimeSpentMinutes,
      });
      if (!result.ok) console.warn(`[Proactive]   -> ${aad}: ${result.reason}`);
    } catch (err) {
      console.error(`[Proactive]   -> ${aad}: threw`, (err as any)?.message ?? err);
    }
  }
}

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
  // Real-time trigger for Feature 1: ensure a Microsoft Graph change-notification subscription
  // exists on the LearningPortalStatus list, pointing at our /api/portal-event endpoint.
  // Best-effort — a failed subscription (bad tunnel URL, missing MSAL token, etc.) does NOT
  // stop the agent; the manual POST path still works for testing.
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
