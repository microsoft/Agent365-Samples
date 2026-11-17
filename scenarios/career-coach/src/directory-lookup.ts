// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Resolves an email sender to a directory user.
 *
 * Graph's get-user endpoint (`/users/{id | userPrincipalName}`) does not accept an arbitrary SMTP
 * address: an internal member who mails from `alice@contoso.com` while their UPN is
 * `alice@tenant.onmicrosoft.com` gets a 404 and would be mistaken for an outsider. When the direct
 * lookup fails, look the address up in the directory's `mail` / `proxyAddresses` instead. The lookup
 * must match exactly ONE user — zero or several is treated as "not resolvable" — and the caller keeps
 * its member-only restriction, so guests and external senders are still ignored.
 */

import type { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';

export interface DirectoryUser { id?: string; displayName?: string; userType?: string }

const FIELDS = 'id,displayName,userType';
// A conservative address shape; anything else is never sent to Graph as a filter value.
const ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const odataString = (value: string): string => value.replace(/'/g, "''");

export async function resolveDirectoryUser(graph: MsGraphClient, address: string): Promise<DirectoryUser | null> {
    const candidate = address.trim();
    if (!candidate) return null;

    // 1) Object id or UPN.
    try {
        const direct: DirectoryUser = await graph.api(`/users/${encodeURIComponent(candidate)}`).select(FIELDS).get();
        if (direct?.id) return direct;
    } catch (err) {
        console.warn('[Email] Direct sender lookup failed — trying the SMTP address:', (err as any)?.statusCode ?? (err as any)?.message ?? err);
    }

    // 2) SMTP address (primary mail, or any proxy address). Advanced query: needs $count + ConsistencyLevel.
    if (!ADDRESS.test(candidate)) return null;
    const a = odataString(candidate);
    const filter = `mail eq '${a}' or proxyAddresses/any(p:p eq 'smtp:${a}') or proxyAddresses/any(p:p eq 'SMTP:${a}')`;
    try {
        const res: any = await graph.api('/users')
            .header('ConsistencyLevel', 'eventual')
            .filter(filter)
            .select(FIELDS)
            .count(true)
            .top(2)
            .get();
        const matches: DirectoryUser[] = (res?.value ?? []).filter((u: DirectoryUser) => !!u?.id);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) console.warn('[Email] Sender address matches more than one directory user — not resolving it.');
    } catch (err) {
        console.warn('[Email] SMTP sender lookup failed:', (err as any)?.statusCode ?? (err as any)?.message ?? err);
    }
    return null;
}
