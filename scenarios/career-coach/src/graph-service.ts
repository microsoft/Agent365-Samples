// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Delegated Microsoft Graph client for the Employee Career Coach.
 *
 * Auth model (POC-simple):
 * - `src/scripts/setup-sharepoint.ts` runs an MSAL device-code flow ONCE and persists the
 *   token cache to `.mstoken-cache.json` in the sample-agent folder.
 * - Runtime code (`getGraphClient()`) reads that cache and calls `acquireTokenSilent`
 *   to keep the token fresh. If the refresh token has expired, we throw with a clear
 *   message telling the developer to re-run `npm run setup:sharepoint`.
 *
 * Why delegated? The Az CLI app in this tenant doesn't have `Sites.Manage.All`
 * consented, and we cannot elevate an application permission for the agent identity.
 * Device-code + a public-client app (Microsoft Graph PowerShell by default) lets the
 * signed-in developer consent to the scopes they need on their own tenant resources.
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
import type { TurnContext, Authorization } from '@microsoft/agents-hosting';

const CACHE_FILE = path.resolve(process.cwd(), '.mstoken-cache.json');

/**
 * Delegated scopes used by the setup/seed scripts and the Feature 4 mail path.
 * - `Sites.Manage.All` — required by `setup-sharepoint.ts` to create lists.
 * - `Sites.ReadWrite.All` — required to add items / add columns to existing lists.
 * - `User.Read.All` — required by Feature 4 for `/me/manager` at 100% completion.
 * - `Mail.Send` — required by Feature 4 to send the celebration email.
 * - `offline_access` — get a refresh token so silent auth keeps working.
 *
 * NOTE: `Sites.Manage.All` and `User.Read.All` are admin-restricted delegated permissions.
 * In a fresh tenant a non-admin cannot consent to them, so the one-time device-code sign-in
 * must be performed by (or pre-consented by) a tenant / SharePoint admin. This is delegated
 * auth only — no application-permission client secret is used.
 */
export const GRAPH_SCOPES = [
    'offline_access',
    'User.Read',
    'User.Read.All',
    'Sites.ReadWrite.All',
    'Sites.Manage.All',
    'Mail.Send',
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
    // Well-known Microsoft Graph PowerShell first-party app — has all our delegated scopes
    // pre-authorized, no custom app-registration needed. Override via env if you prefer a
    // private client id (must be a public client capable of the device-code flow).
    const clientId = process.env.GRAPH_AUTH_CLIENT_ID || '14d82eec-204b-4c2f-b7e8-296a70dab67e';
    const tenantId =
        process.env.GRAPH_AUTH_TENANT_ID ||
        process.env.connections__service_connection__settings__tenantId ||
        'common';
    const msalConfig: Configuration = {
        auth: {
            clientId,
            authority: `https://login.microsoftonline.com/${tenantId}`,
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

// -----------------------------------------------------------------------------
// Agentic-auth path (runtime). This is what the AGENT uses at runtime — it does
// NOT depend on the MSAL device-code cache. Each turn, we exchange the agentic
// identity's token for a Microsoft Graph token via the A365 SDK's auth handler.
// The A365 platform manages the token lifecycle, so there is no manual refresh.
//
// Requires the agentic identity (Career Coach app registration) to have Graph
// scopes consented in Entra. If Graph returns 403 on the first call, an admin
// needs to consent `Sites.ReadWrite.All`, `User.Read.All`, and `Mail.Send` for
// that app registration once. The error surface bubbles the missing scope name.
// -----------------------------------------------------------------------------

export const AGENTIC_GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];

/**
 * Exchanges the current agentic-identity token for a Microsoft Graph token, using
 * the auth handler registered on the AgentApplication (see agent.ts constructor).
 */
export async function getAgenticGraphToken(
    turnContext: TurnContext,
    authorization: Authorization,
    authHandlerId = 'agentic',
): Promise<string> {
    const res = await authorization.exchangeToken(turnContext, authHandlerId, {
        scopes: AGENTIC_GRAPH_SCOPES,
    });
    const token = (res as any)?.token ?? '';
    if (!token) {
        throw new Error(
            'Agentic Graph token exchange returned no token. Check that the Career Coach ' +
            'app registration has Graph scopes consented (Sites.ReadWrite.All, User.Read.All, Mail.Send).',
        );
    }
    return token;
}

/**
 * Builds a Microsoft Graph client backed by the agentic identity's token. Each Graph
 * call inside a single turn re-uses the same token (SDK caches until near expiry).
 */
export function getAgenticGraphClient(turnContext: TurnContext, authorization: Authorization): MsGraphClient {
    return MsGraphClient.init({
        authProvider: async (done) => {
            try {
                const token = await getAgenticGraphToken(turnContext, authorization);
                done(null, token);
            } catch (e) {
                done(e as Error, null);
            }
        },
    });
}

/**
 * Resolves the SharePoint site id for the CareerCoach site (from SP_SITE_HOST + SP_SITE_PATH).
 */
export async function getSiteId(): Promise<string> {
    const host = process.env.SP_SITE_HOST || 'contoso.sharepoint.com';
    const sitePath = (process.env.SP_SITE_PATH || '/sites/CareerCoach').replace(/^\//, '');
    const graph = getGraphClient();
    const site = await graph.api(`/sites/${host}:/${sitePath}`).get();
    return site.id as string;
}
// -----------------------------------------------------------------------------
// Runtime helpers — used by the agent's message handler (Feature 4 email flow).
// All calls act as the signed-in developer because the MSAL cache holds their
// delegated token. That means /me refers to the developer, /me/manager refers to
// their manager, /me/sendMail sends AS the developer. For a POC/demo this is
// intentional; in production, per-user delegated auth or app-only Sites.Selected
// would replace this. Documented in the plan.
// -----------------------------------------------------------------------------

export interface UserProfile {
    displayName: string;
    mail: string;             // primary SMTP if present; falls back to userPrincipalName
    userPrincipalName: string;
}

export interface ManagerInfo {
    displayName: string;
    mail: string;
}

/**
 * Reads /users/{userId} (or /me if userId is omitted). Used to fill the CC address
 * on the completion email. Prefer the userId form when running under agentic auth,
 * which is app-only and doesn't understand `/me`.
 */
export async function getMyProfile(graph?: MsGraphClient, userId?: string): Promise<UserProfile> {
    const g = graph ?? getGraphClient();
    const path = userId ? `/users/${userId}` : '/me';
    const me = await g.api(path).select('displayName,mail,userPrincipalName').get();
    return {
        displayName: me.displayName ?? me.userPrincipalName ?? 'Employee',
        mail: me.mail ?? me.userPrincipalName ?? '',
        userPrincipalName: me.userPrincipalName ?? '',
    };
}

/**
 * Reads /users/{userId}/manager (or /me/manager if userId is omitted). Returns null
 * if no manager is set on the account (Graph 404).
 */
export async function getMyManager(graph?: MsGraphClient, userId?: string): Promise<ManagerInfo | null> {
    const g = graph ?? getGraphClient();
    const path = userId ? `/users/${userId}/manager` : '/me/manager';
    try {
        const m = await g.api(path).select('displayName,mail,userPrincipalName').get();
        const mail = m.mail ?? m.userPrincipalName ?? '';
        if (!mail) return null;
        return { displayName: m.displayName ?? mail, mail };
    } catch (err: any) {
        const code = err?.statusCode ?? err?.code ?? '';
        if (code === 404 || String(err?.message ?? '').includes('does not exist')) return null;
        throw err;
    }
}

export interface SendMailArgs {
    to: string[];
    cc?: string[];
    subject: string;
    htmlBody: string;
    /** Optional. If provided, sends via `/users/{userId}/sendMail` (works with app-only agentic auth). */
    fromUserId?: string;
    /** Optional. Reuse a pre-built Graph client (e.g. the agentic one). */
    graph?: MsGraphClient;
}

/**
 * Sends an HTML email via /users/{userId}/sendMail (MSAL app path) or /me/sendMail (delegated path).
 * Feature 4 uses UserState.Completion100Fired to guarantee we only call this once per user's plan.
 *
 * IMPORTANT: When called with an agentic/delegated Graph client (i.e. `graph` is provided),
 * we always use /me/sendMail — SharePoint/Graph rejects /users/{userId}/sendMail on delegated
 * tokens even when the userId matches the caller. Only MSAL app-context can address other users.
 */
export async function sendMail({ to, cc, subject, htmlBody, fromUserId, graph }: SendMailArgs): Promise<void> {
    if (!to?.length) throw new Error('sendMail: "to" is required and must not be empty.');
    const g = graph ?? getGraphClient();
    // Delegated (agentic) path → /me/sendMail. App (MSAL) path → /users/{id}/sendMail.
    const path = graph
        ? '/me/sendMail'
        : (fromUserId ? `/users/${fromUserId}/sendMail` : '/me/sendMail');
    await g.api(path).post({
        message: {
            subject,
            body: { contentType: 'HTML', content: htmlBody },
            toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
            ccRecipients: (cc ?? []).map((addr) => ({ emailAddress: { address: addr } })),
        },
        saveToSentItems: true,
    });
}

// -----------------------------------------------------------------------------
// SharePoint list helpers + Microsoft Graph change-notification subscriptions.
// Used by the subscription-manager to wire up the "SharePoint list updated ->
// agent DMs the user" real-time trigger, without Power Automate.
// -----------------------------------------------------------------------------

export async function getListIdByName(siteId: string, listDisplayName: string): Promise<string | null> {
    const graph = getGraphClient();
    const escaped = listDisplayName.replace(/'/g, "''");
    const res = await graph
        .api(`/sites/${siteId}/lists?$filter=displayName eq '${escaped}'`)
        .get()
        .catch(() => ({ value: [] as any[] }));
    return (res?.value?.[0]?.id as string) ?? null;
}

/**
 * Reads every item in a list, expanding the `fields` object so callers get column values
 * directly on `item.fields`. Used to enumerate `LearningPortalStatus` rows on notification.
 */
export async function getListItems(siteId: string, listId: string): Promise<Array<{ id: string; fields: Record<string, any> }>> {
    const graph = getGraphClient();
    const rows: Array<{ id: string; fields: Record<string, any> }> = [];
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        for (const item of page?.value ?? []) rows.push({ id: item.id, fields: item.fields ?? {} });
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    return rows;
}

// --- Graph change-notification subscriptions ---

export interface GraphSubscription {
    id: string;
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState?: string;
    applicationId?: string;
}

export async function listSubscriptions(): Promise<GraphSubscription[]> {
    const graph = getGraphClient();
    const res = await graph.api('/subscriptions').get();
    return (res?.value ?? []) as GraphSubscription[];
}

export async function createSubscription(input: {
    resource: string;               // e.g. 'sites/{siteId}/lists/{listId}'
    notificationUrl: string;        // https://<tunnel>/api/portal-event
    changeType?: string;            // default 'updated' (list resource supports 'updated')
    expirationMinutes?: number;     // default 60 (max ~4230 for lists, but we auto-renew)
    clientState?: string;
}): Promise<GraphSubscription> {
    const graph = getGraphClient();
    const expiration = new Date(Date.now() + 60_000 * (input.expirationMinutes ?? 60)).toISOString();
    return await graph.api('/subscriptions').post({
        changeType: input.changeType ?? 'updated',
        notificationUrl: input.notificationUrl,
        resource: input.resource,
        expirationDateTime: expiration,
        clientState: input.clientState,
    });
}

export async function renewSubscription(subscriptionId: string, expirationMinutes = 60): Promise<GraphSubscription> {
    const graph = getGraphClient();
    const expiration = new Date(Date.now() + 60_000 * expirationMinutes).toISOString();
    return await graph.api(`/subscriptions/${subscriptionId}`).patch({ expirationDateTime: expiration });
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
    const graph = getGraphClient();
    try {
        await graph.api(`/subscriptions/${subscriptionId}`).delete();
    } catch (err: any) {
        // 404 is fine — already gone.
        const code = err?.statusCode ?? err?.code ?? '';
        if (code !== 404 && code !== '404') throw err;
    }
}