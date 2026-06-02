// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Background service that acquires an Observability API token via a 3-hop FMI chain
 * and caches it for the A365 exporter.
 *
 * Token flow:
 *   Hop 1+2: Blueprint authenticates (MSI in prod, client secret locally) ->
 *            gets T1 via acquireTokenByClientCredential with fmiPath targeting Agent Identity.
 *   Hop 3:   Agent Identity uses T1 as assertion -> Observability API token.
 *
 * Auth strategy is controlled by AGENT365_USE_MANAGED_IDENTITY:
 *   true  (production)  - MSI -> Blueprint FIC -> Agent Identity -> API
 *   false (local dev)   - Client Secret -> Blueprint FIC -> Agent Identity -> API
 */

import { ConfidentialClientApplication } from '@azure/msal-node';
import { ManagedIdentityCredential } from '@azure/identity';
import { cacheToken } from './token-cache';

const FMI_SCOPES = ['api://AzureADTokenExchange/.default'];
const OBSERVABILITY_SCOPES = ['api://9b975845-388f-4429-889e-eab1ef63949c/.default'];
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

export interface TokenServiceConfig {
  tenantId: string;
  agentId: string;
  blueprintClientId: string;
  blueprintClientSecret: string;
  useManagedIdentity: boolean;
}

export function startTokenService(config: TokenServiceConfig): ReturnType<typeof setInterval> {
  console.log(`ObservabilityTokenService started (useManagedIdentity=${config.useManagedIdentity}).`);

  const run = async () => {
    try {
      await acquireAndRegisterToken(config);
    } catch (error) {
      console.warn(`Failed to acquire observability token; will retry in ${REFRESH_INTERVAL_MS / 1000}s.`, error);
    }
  };

  // Acquire immediately, then on interval
  run();
  return setInterval(run, REFRESH_INTERVAL_MS);
}

async function acquireAndRegisterToken(config: TokenServiceConfig): Promise<void> {
  const authority = `https://login.microsoftonline.com/${config.tenantId}`;

  // Hop 1+2: Blueprint -> T1 via FMI path
  const t1Token = config.useManagedIdentity
    ? await acquireT1ViaMsi(authority, config.blueprintClientId, config.agentId)
    : await acquireT1ViaClientSecret(authority, config.blueprintClientId, config.blueprintClientSecret, config.agentId);

  // Hop 3: Agent Identity uses T1 -> Observability API token
  const identityApp = new ConfidentialClientApplication({
    auth: {
      clientId: config.agentId,
      authority,
      clientAssertion: t1Token,
    },
  });

  const obsResult = await identityApp.acquireTokenByClientCredential({
    scopes: OBSERVABILITY_SCOPES,
  });

  if (!obsResult?.accessToken) {
    throw new Error('Failed to acquire observability token: no access token returned');
  }

  // Use the actual token expiry from MSAL when available, otherwise fall back to 55 minutes
  const expiresInMs = obsResult.expiresOn
    ? obsResult.expiresOn.getTime() - Date.now()
    : 55 * 60 * 1000;
  cacheToken(config.agentId, config.tenantId, obsResult.accessToken, expiresInMs);
  console.log(`Observability token registered for agent ${config.agentId}.`);
}

async function acquireT1ViaMsi(authority: string, blueprintClientId: string, agentId: string): Promise<string> {
  // ManagedIdentityCredential.getToken uses a resource URI (no /.default suffix).
  const credential = new ManagedIdentityCredential();
  const msiToken = await credential.getToken('api://AzureADTokenExchange');

  const blueprintApp = new ConfidentialClientApplication({
    auth: {
      clientId: blueprintClientId,
      authority,
      clientAssertion: msiToken.token,
    },
  });

  const result = await blueprintApp.acquireTokenByClientCredential({
    scopes: FMI_SCOPES,
    azureRegion: undefined,
    fmiPath: agentId,
  } as any); // fmiPath not yet in stable MSAL types

  if (!result?.accessToken) {
    throw new Error('FMI T1 via MSI failed: no access token returned');
  }
  return result.accessToken;
}

async function acquireT1ViaClientSecret(authority: string, blueprintClientId: string, blueprintClientSecret: string, agentId: string): Promise<string> {
  // Raw HTTP token request — MSAL doesn't support fmipath in current versions,
  // so we POST directly to the Entra ID token endpoint with the parameter.
  const tokenUrl = `${authority}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: blueprintClientId,
    client_secret: blueprintClientSecret,
    scope: FMI_SCOPES[0],
    fmi_path: agentId,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`FMI T1 via client secret failed (${response.status}): ${errorBody}`);
  }

  const json = await response.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error('FMI T1 via client secret failed: no access_token in response');
  }
  return json.access_token;
}

