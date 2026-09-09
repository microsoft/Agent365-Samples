// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Intentionally sample-local: standalone deployments must include this helper.
// Copies across interactive samples are checked by the offline regression suite.

const FMI_SCOPE = 'api://AzureADTokenExchange/.default';
const OBS_RESOURCE = '9b975845-388f-4429-889e-eab1ef63949c';
const OBS_SCOPE = `api://${OBS_RESOURCE}/.default`;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REFRESH_SKEW_MS = 60_000;

export interface ObservabilityTokenConfig {
  tenantId: string;
  agentId: string;
  blueprintClientId: string;
  blueprintClientSecret: string;
}

export class ObservabilityTokenError extends Error {}

function guid(value: unknown, setting: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || value === '00000000-0000-0000-0000-000000000000') {
    throw new ObservabilityTokenError(`${setting} must be a non-placeholder UUID.`);
  }
  return value.toLowerCase();
}

export class ObservabilityTokenService {
  private readonly config: ObservabilityTokenConfig;
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    config: ObservabilityTokenConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.config = {
      tenantId: guid(config.tenantId, 'AGENT365_OBS_TENANT_ID'),
      agentId: guid(config.agentId, 'AGENT365_OBS_AGENT_ID'),
      blueprintClientId: guid(config.blueprintClientId, 'AGENT365_OBS_BLUEPRINT_CLIENT_ID'),
      blueprintClientSecret: config.blueprintClientSecret,
    };
    if (this.config.agentId === this.config.blueprintClientId) {
      throw new ObservabilityTokenError(
        'AGENT365_OBS_AGENT_ID must be the actual agent instance client ID, not its blueprint.',
      );
    }
    const secret = config.blueprintClientSecret;
    if (typeof secret !== 'string' || !secret.trim()
      || /<<|>>|<your|your[_-]|placeholder|changeme|replace[_-]/i.test(secret)
      || /^(secret|dummy|example|\*+|\.+|<\.\.\.>)$/i.test(secret)) {
      throw new ObservabilityTokenError(
        'AGENT365_OBS_BLUEPRINT_CLIENT_SECRET must contain a blueprint credential, not a placeholder.',
      );
    }
  }

  readonly resolve = async (agentId: string, tenantId: string): Promise<string> => {
    if (guid(agentId, 'OBS export agent ID') !== this.config.agentId
      || guid(tenantId, 'OBS export tenant ID') !== this.config.tenantId) {
      throw new ObservabilityTokenError(
        'OBS export identity does not match AGENT365_OBS_AGENT_ID/AGENT365_OBS_TENANT_ID. '
        + 'Configure the matching agent instance; cross-identity export is forbidden.',
      );
    }
    if (this.cached && this.now() < this.cached.expiresAt - REFRESH_SKEW_MS) {
      return this.cached.token;
    }
    if (!this.pending) {
      this.cached = undefined;
      this.pending = this.acquire().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  };

  private async post(fields: Record<string, string>, step: string): Promise<Record<string, unknown>> {
    let result: unknown;
    try {
      const response = await this.request(
        `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new ObservabilityTokenError(
          `OBS ${step} token request failed (HTTP ${response.status}). `
          + 'Check the agent instance, blueprint credential and OBS application role consent.',
        );
      }
      result = await response.json();
    } catch (error) {
      if (error instanceof ObservabilityTokenError) throw error;
      // Transport/JSON errors can contain secrets or response bodies.
      throw new ObservabilityTokenError(
        `OBS ${step} token request failed. Check connectivity and dedicated OBS configuration.`,
      );
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ObservabilityTokenError(`OBS ${step} returned an invalid token response.`);
    }
    const response = result as Record<string, unknown>;
    if (response['error'] || typeof response['access_token'] !== 'string' || !response['access_token'].trim()
      || typeof response['token_type'] !== 'string' || response['token_type'].toLowerCase() !== 'bearer') {
      throw new ObservabilityTokenError(
        `OBS ${step} did not return a bearer token. No delegated-token fallback is permitted.`,
      );
    }
    return response;
  }

  private async acquire(): Promise<string> {
    const parent = await this.post({
      grant_type: 'client_credentials',
      client_id: this.config.blueprintClientId,
      client_secret: this.config.blueprintClientSecret,
      scope: FMI_SCOPE,
      fmi_path: this.config.agentId,
    }, 'blueprint FMI');
    const requestedAt = this.now();
    const result = await this.post({
      grant_type: 'client_credentials',
      client_id: this.config.agentId,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: parent['access_token'] as string,
      scope: OBS_SCOPE,
    }, 'agent application');
    const token = result['access_token'] as string;
    let claims: Record<string, unknown>;
    try {
      const parts = token.split('.');
      const payload = parts[1];
      if (parts.length !== 3 || parts.some(part => !part) || !payload) throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      claims = parsed as Record<string, unknown>;
    } catch {
      throw new ObservabilityTokenError('OBS returned an invalid JWT.');
    }
    // Type/identity guards, not signature validation. The OBS service validates
    // the token obtained directly from Entra's fixed HTTPS endpoint.
    const roles = claims['roles'];
    if (Object.prototype.hasOwnProperty.call(claims, 'scp')
      || !Array.isArray(roles) || !roles.length
      || !roles.every(role => typeof role === 'string' && role.length > 0)
      || (claims['idtyp'] !== undefined && claims['idtyp'] !== 'app')) {
      throw new ObservabilityTokenError(
        'OBS requires application roles and an app-only token without scp/user claims.',
      );
    }
    const clients = ['azp', 'appid'].filter(key => Object.prototype.hasOwnProperty.call(claims, key));
    if (!clients.length || clients.some(key => guid(claims[key], 'OBS token client') !== this.config.agentId)
      || guid(claims['tid'], 'OBS token tenant') !== this.config.tenantId
      || ![OBS_RESOURCE, `api://${OBS_RESOURCE}`].includes(claims['aud'] as string)) {
      throw new ObservabilityTokenError('OBS token identity or audience does not match its configuration.');
    }
    const expiries: number[] = [];
    for (const [source, key, offset] of [
      [result, 'expires_in', requestedAt],
      [claims, 'exp', 0],
    ] as const) {
      if (source[key] === undefined) continue;
      const raw = source[key];
      const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim())
        ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value <= 0) {
        throw new ObservabilityTokenError(`OBS token has invalid ${key}.`);
      }
      expiries.push(offset + value * 1000);
    }
    const expiresAt = Math.min(...expiries);
    if (!expiries.length || !Number.isFinite(expiresAt) || expiresAt <= this.now() + REFRESH_SKEW_MS) {
      throw new ObservabilityTokenError('OBS token is expired, near expiry, or lacks expires_in/exp.');
    }
    this.cached = { token, expiresAt };
    return token;
  }
}

export function createObservabilityTokenResolver(
  environment: NodeJS.ProcessEnv = process.env,
): (agentId: string, tenantId: string) => Promise<string> {
  if (!['true', '1', 'yes'].includes(
    (environment['ENABLE_A365_OBSERVABILITY_EXPORTER'] ?? '').toLowerCase(),
  )) {
    return async () => {
      throw new ObservabilityTokenError('OBS export is disabled; no token was acquired.');
    };
  }
  return new ObservabilityTokenService({
    tenantId: environment['AGENT365_OBS_TENANT_ID'] ?? '',
    agentId: environment['AGENT365_OBS_AGENT_ID'] ?? '',
    blueprintClientId: environment['AGENT365_OBS_BLUEPRINT_CLIENT_ID'] ?? '',
    blueprintClientSecret: environment['AGENT365_OBS_BLUEPRINT_CLIENT_SECRET'] ?? '',
  }).resolve;
}
