// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365 Observability — best-effort instrumentation (verify against official sample)
import type { AuthProvider } from '@microsoft/agents-hosting';

const OBS_RESOURCE = '9b975845-388f-4429-889e-eab1ef63949c';
const REFRESH_SKEW_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConnectionProvider = () => AuthProvider;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAppTokenResolver(getProvider: ConnectionProvider) {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  const failedUntil = new Map<string, number>();

  const acquire = async (agentId: string, tenantId: string): Promise<string> => {
    const assertion = await getProvider().getAgenticApplicationToken(tenantId, agentId);
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: agentId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope: `api://${OBS_RESOURCE}/.default`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`[A365 Observability] Token endpoint returned HTTP ${response.status}.`);
      throw new Error('Observability token request failed.');
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.access_token !== 'string') {
      throw new Error('Observability token response had no access_token.');
    }
    const token = body.access_token;
    const payload = token.split('.')[1];
    if (!payload) throw new Error('Observability token is not a JWT.');
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(claims) || 'scp' in claims ||
        String(claims.azp ?? claims.appid ?? '').toLowerCase() !== agentId.toLowerCase() ||
        String(claims.tid ?? '').toLowerCase() !== tenantId.toLowerCase() ||
        ![OBS_RESOURCE, `api://${OBS_RESOURCE}`].includes(String(claims.aud)) ||
        typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()) {
      throw new Error('Observability token must be app-only and match the exporting agent, tenant, and audience.');
    }

    cache.set(`${tenantId}:${agentId}`.toLowerCase(), { token, expiresAt: claims.exp * 1000 });
    return token;
  };

  return async (agentId: string, tenantId: string): Promise<string> => {
    if (!GUID.test(agentId) || !GUID.test(tenantId)) {
      console.warn('[A365 Observability] Skipping export: a valid runtime agent and tenant identity is required.');
      return '';
    }
    const key = `${tenantId}:${agentId}`.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt - REFRESH_SKEW_MS) return cached.token;
    if (Date.now() < (failedUntil.get(key) ?? 0)) return '';

    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = acquire(agentId, tenantId)
        .then(token => {
          failedUntil.delete(key);
          return token;
        })
        .catch(() => {
          failedUntil.set(key, Date.now() + FAILURE_BACKOFF_MS);
          console.warn('[A365 Observability] App-only token acquisition or claim validation failed; retrying after backoff.');
          return '';
        })
        .finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    return inFlight;
  };
}
