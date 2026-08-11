// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Standalone Graph worker: acquire application-permission tokens for
// Microsoft Graph via client credentials. Used by acquireGraphToken() in
// peopleTools.ts when GRAPH_APP_ID / GRAPH_APP_SECRET / GRAPH_TENANT_ID
// are set.
//
// Why: the agentic OBO chain (blueprint → instance app → user OBO → Graph)
// is powerful but painful to consent in demo tenants (AADSTS82007 etc). A
// dedicated worker app with application permissions is a strict simplification
// for the "reach into Graph and read/write on the leader's behalf" plumbing.
//
// MSAL's ConfidentialClientApplication caches tokens internally, so we don't
// need to add a manual cache layer — we just keep the client instance across
// calls.

import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { log } from '../util/logger';

let cachedClient: ConfidentialClientApplication | null = null;

/**
 * Are the env vars set to enable the standalone Graph worker?
 * If false, callers fall back to the agentic OBO exchange.
 */
export function isGraphAppConfigured(): boolean {
  return (
    !!process.env.GRAPH_APP_ID?.trim() &&
    !!process.env.GRAPH_APP_SECRET?.trim() &&
    !!process.env.GRAPH_TENANT_ID?.trim()
  );
}

function getClient(): ConfidentialClientApplication {
  if (cachedClient) return cachedClient;

  const clientId = process.env.GRAPH_APP_ID!.trim();
  const clientSecret = process.env.GRAPH_APP_SECRET!.trim();
  const tenantId = process.env.GRAPH_TENANT_ID!.trim();

  cachedClient = new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    system: {
      loggerOptions: {
        loggerCallback(level, message) {
          if (level <= LogLevel.Warning) log.warn('graphAppToken', message);
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Warning,
      },
    },
  });

  log.info('graphAppToken', `standalone Graph worker configured (appId=${clientId.slice(0, 8)}… tenant=${tenantId.slice(0, 8)}…)`);
  return cachedClient;
}

/**
 * Get an application-permission token for Microsoft Graph.
 * Uses MSAL's built-in cache; only hits AAD when the current token is near
 * expiry.
 */
export async function acquireAppOnlyGraphToken(): Promise<string> {
  const client = getClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result?.accessToken) {
    throw new Error(
      '[graphAppToken] acquireTokenByClientCredential returned no accessToken'
    );
  }
  log.trace('graphAppToken', `acquired token (expires ${result.expiresOn?.toISOString() ?? '?'})`);
  return result.accessToken;
}
