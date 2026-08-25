// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Delegated Microsoft Graph client for the Scrum Master Assistant.
 *
 * Auth model (POC-simple):
 * - `scripts/setup-sharepoint.ts` runs an MSAL device-code flow ONCE and persists the
 *   token cache to `.mstoken-cache.json` in the sample-agent folder.
 * - Runtime code (`getGraphClient()`) reads that cache and calls `acquireTokenSilent`
 *   to keep the token fresh. If the refresh token has expired, we throw with a clear
 *   message telling the developer to re-run `npm run setup:sharepoint`.
 *
 * Prod hardening (v2): switch to app-only with Sites.Selected, or bind the cache to
 * Key Vault. Documented in the plan; intentionally out of scope for the POC.
 */

import 'isomorphic-fetch';
import * as fs from 'fs';
import * as path from 'path';

import {
    PublicClientApplication,
    Configuration,
    AccountInfo,
    DeviceCodeRequest,
    SilentFlowRequest,
    ICachePlugin,
    TokenCacheContext,
} from '@azure/msal-node';

import { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';
import { getGraphAuthConfig } from '../config';

const CACHE_FILE = path.resolve(process.cwd(), '.mstoken-cache.json');

// Scopes needed by every SMA runtime path. Sites.Manage.All is required by the
// setup script to create the SMA_* lists.
//
// Note: no Calendars scope here — the Chase unblock-meeting flow now goes through
// `mcp_CalendarTools` (A365 platform), not direct Graph, so no user calendar consent
// is needed. Adding a scope here without re-running `npm run setup:sharepoint` will
// cause AADSTS65001 (consent required) because the cached token predates the new
// scope list.
export const GRAPH_SCOPES = [
    'offline_access',
    'User.Read',
    'Sites.ReadWrite.All',
    'Sites.Manage.All',
    'Files.ReadWrite.All',
];

// Simple file-backed MSAL cache. Not encrypted — for local dev only.
const filePlugin: ICachePlugin = {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
        if (fs.existsSync(CACHE_FILE)) {
            ctx.tokenCache.deserialize(fs.readFileSync(CACHE_FILE, 'utf-8'));
        }
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
        if (ctx.cacheHasChanged) {
            fs.writeFileSync(CACHE_FILE, ctx.tokenCache.serialize(), 'utf-8');
        }
    },
};

let pca: PublicClientApplication | null = null;
function getPca(): PublicClientApplication {
    if (pca) return pca;
    const cfg = getGraphAuthConfig();
    const msalConfig: Configuration = {
        auth: {
            clientId: cfg.clientId,
            authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
        },
        cache: { cachePlugin: filePlugin },
    };
    pca = new PublicClientApplication(msalConfig);
    return pca;
}

/**
 * One-time interactive device-code flow for the setup script.
 * Prints a code + verification URL, blocks until the developer signs in.
 */
export async function acquireTokenViaDeviceCode(): Promise<string> {
    const app = getPca();
    const request: DeviceCodeRequest = {
        scopes: GRAPH_SCOPES,
        deviceCodeCallback: (info) => {
            console.log('');
            console.log('======================================================');
            console.log(' Microsoft sign-in required (device code flow)');
            console.log('------------------------------------------------------');
            console.log(` 1. Open ${info.verificationUri}`);
            console.log(` 2. Enter code: ${info.userCode}`);
            console.log('======================================================');
            console.log('');
        },
    };
    const result = await app.acquireTokenByDeviceCode(request);
    if (!result?.accessToken) throw new Error('Device code flow returned no access token');
    return result.accessToken;
}

/**
 * Silent token acquisition for runtime use.
 * Requires that setup-sharepoint.ts has already run and persisted a cache entry.
 */
export async function acquireTokenSilentForGraph(): Promise<string> {
    const app = getPca();
    const cache = app.getTokenCache();
    const accounts: AccountInfo[] = await cache.getAllAccounts();
    if (accounts.length === 0) {
        throw new Error(
            'No cached Microsoft account found. Run `npm run setup:sharepoint` once to sign in.',
        );
    }
    const request: SilentFlowRequest = { account: accounts[0], scopes: GRAPH_SCOPES };
    const result = await app.acquireTokenSilent(request);
    if (!result?.accessToken) {
        throw new Error(
            'Silent token acquisition returned no access token. Re-run `npm run setup:sharepoint` to refresh.',
        );
    }
    return result.accessToken;
}

/**
 * Returns a `@microsoft/microsoft-graph-client` instance whose auth provider
 * lazily fetches a fresh token per request via `acquireTokenSilentForGraph()`.
 */
export function getGraphClient(): MsGraphClient {
    return MsGraphClient.init({
        authProvider: async (done) => {
            try {
                const token = await acquireTokenSilentForGraph();
                done(null, token);
            } catch (e) {
                done(e as Error, null);
            }
        },
    });
}
