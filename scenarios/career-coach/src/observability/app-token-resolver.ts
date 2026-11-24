// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365 Observability — best-effort instrumentation (verify against official sample)
// App-only token for A365 observability export over the S2S route. Workload auth
// (agentic user for Graph / MCP) is unchanged; only the telemetry credential differs.
//   Step 1: the agent's hosting connection (the blueprint credential) issues an FMI assertion
//           for the exporting agent identity: getAgenticApplicationToken(tenantId, agentId).
//   Step 2: the agent identity exchanges that assertion (client_credentials) for an app-only
//           Observability API token. The S2S route rejects delegated (scp) tokens.
import type { AuthProvider } from '@microsoft/agents-hosting';

const OBS_SCOPE = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default';
const OBS_AUDIENCES = new Set(['api://9b975845-388f-4429-889e-eab1ef63949c', '9b975845-388f-4429-889e-eab1ef63949c']);
const REFRESH_SKEW_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;

/** Returns the agent's hosting connection; called lazily because the adapter is created after observability init. */
export type ConnectionProvider = () => AuthProvider;

type CachedToken = { token: string; expiresAt: number };

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Observability token is not a JWT.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function createAppTokenResolver(getProvider: ConnectionProvider) {
  const cache = new Map<string, CachedToken>();
  const pending = new Map<string, Promise<string>>();
  const failedUntil = new Map<string, number>();
  const announced = new Set<string>();

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
        scope: OBS_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    // Never log the response body: it can echo request details.
    if (!response.ok) throw new Error(`Observability token request failed (HTTP ${response.status}).`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    const token = body.access_token;
    if (!token) throw new Error('Observability token response had no access_token.');

    const claims = decodeClaims(token);
    if ('scp' in claims) throw new Error('Observability token is delegated (scp claim); the S2S route rejects it.');
    const client = String(claims['azp'] ?? claims['appid'] ?? '').toLowerCase();
    if (client !== agentId.toLowerCase() || String(claims['tid'] ?? '').toLowerCase() !== tenantId.toLowerCase()) {
      throw new Error('Observability token client or tenant does not match the exporting agent.');
    }
    const audience = String(claims['aud'] ?? '');
    if (!OBS_AUDIENCES.has(audience)) {
      throw new Error('Observability token audience does not match the Observability API.');
    }
    const exp = claims['exp'];
    const expiresAt = typeof exp === 'number' ? exp * 1000 : Date.now() + (body.expires_in ?? 0) * 1000;
    const key = `${tenantId}:${agentId}`.toLowerCase();
    cache.set(key, { token, expiresAt });
    if (!announced.has(key)) {
      announced.add(key);
      console.log(`[A365 Observability] App-only export token acquired for agent ${agentId} (S2S route).`);
    }
    return token;
  };

  // Wired as a365.tokenResolver. The exporter calls it for every export batch, so serve from
  // the cache and share one in-flight request per agent identity.
  return async (agentId: string, tenantId: string): Promise<string> => {
    if (!agentId || !tenantId) return '';
    const key = `${tenantId}:${agentId}`.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt - REFRESH_SKEW_MS) return cached.token;
    const retryAfter = failedUntil.get(key);
    if (retryAfter && Date.now() < retryAfter) return '';
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = acquire(agentId, tenantId).finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    try {
      const token = await inFlight;
      failedUntil.delete(key);
      return token;
    } catch (err) {
      failedUntil.set(key, Date.now() + FAILURE_BACKOFF_MS);
      console.warn('[A365 Observability] App-only token acquisition failed:', (err as Error).message);
      return '';
    }
  };
}
