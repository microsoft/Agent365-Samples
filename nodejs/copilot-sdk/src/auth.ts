// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import type { LiveIdentity } from './config.js';

export const OBSERVABILITY_SCOPE = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default';
const EXCHANGE_SCOPE = 'api://AzureADTokenExchange/.default';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface AccessToken {
  accessToken: string;
  expiresOn: Date | null;
}

export type AcquireAgentToken = () => Promise<AccessToken | null>;

export function createTokenResolver(
  identity: LiveIdentity,
  acquire: AcquireAgentToken = createMsalAcquirer(identity),
  now: () => number = Date.now,
): (agentId: string, tenantId: string, scopes?: string[]) => Promise<string> {
  let cached: AccessToken | undefined;
  let pending: Promise<string> | undefined;
  return async (agentId, tenantId, scopes) => {
    if (agentId !== identity.agentId || tenantId !== identity.tenantId) {
      throw new Error('A365 token resolver identity mismatch');
    }
    if (scopes?.some(scope => scope !== OBSERVABILITY_SCOPE)) {
      throw new Error('A365 token resolver received an unexpected scope');
    }
    if (cached?.expiresOn && cached.expiresOn.getTime() - REFRESH_SKEW_MS > now()) {
      return cached.accessToken;
    }
    if (!pending) {
      pending = (async () => {
        const result = await acquire();
        if (!result?.accessToken || !result.expiresOn ||
            result.expiresOn.getTime() - REFRESH_SKEW_MS <= now()) {
          throw new Error('A365 token acquisition returned no usable token or expiry');
        }
        cached = result;
        return result.accessToken;
      })().finally(() => { pending = undefined; });
    }
    return pending;
  };
}

function createMsalAcquirer(identity: LiveIdentity): AcquireAgentToken {
  const authority = `https://login.microsoftonline.com/${identity.tenantId}`;
  const system = { loggerOptions: { piiLoggingEnabled: false, logLevel: LogLevel.Error } };
  const blueprint = new ConfidentialClientApplication({
    auth: { authority, clientId: identity.blueprintClientId, clientSecret: identity.clientSecret },
    system,
  });
  const agent = new ConfidentialClientApplication({
    auth: {
      authority,
      clientId: identity.agentId,
      clientAssertion: async () => {
        const result = await blueprint.acquireTokenByClientCredential({
          scopes: [EXCHANGE_SCOPE],
          fmiPath: identity.agentId,
        });
        if (!result?.accessToken) throw new Error('Blueprint token was not returned');
        return result.accessToken;
      },
    },
    system,
  });
  return async () => {
    try {
      return await agent.acquireTokenByClientCredential({ scopes: [OBSERVABILITY_SCOPE] });
    } catch (error) {
      // Do not copy MSAL response bodies, assertions, or credential-bearing causes into logs.
      const code = error instanceof Error && 'errorCode' in error &&
        typeof error.errorCode === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.errorCode)
        ? error.errorCode : 'token_acquisition_failed';
      throw new Error(`A365 S2S authentication failed (${code}); check blueprint credentials, FMI identity and OtelWrite consent`);
    }
  };
}
