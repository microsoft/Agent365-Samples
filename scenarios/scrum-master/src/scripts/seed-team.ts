// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Seed the SharePoint TeamMembers list.
 *
 * Modes:
 *   npm run seed -- --mock          use the built-in 5-person mock roster
 *   npm run seed -- --from=./team.json
 *                                   load rows from a JSON file matching TeamMemberFields
 *
 * Idempotent — rows are matched on AadObjectId and updated in place.
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import * as fs from 'fs';
import * as path from 'path';

import { findByField, createItem, updateItem } from '../services/sharepoint';
import { TeamMemberFields } from '../services/team-roster';
import { getGraphClient } from '../services/graph';

async function tryResolveCurrentUserAad(): Promise<{ id: string; mail: string } | null> {
    try {
        const me = await getGraphClient().api('/me').get();
        if (me?.id) return { id: me.id, mail: (me.mail ?? me.userPrincipalName ?? '').toLowerCase() };
    } catch (e) {
        console.warn('[seed] Could not resolve /me from Graph:', (e as Error).message);
    }
    return null;
}

function parseArgs(): { mock: boolean; from: string | null } {
    const args = process.argv.slice(2);
    let mock = false;
    let from: string | null = null;
    for (const a of args) {
        if (a === '--mock') mock = true;
        else if (a.startsWith('--from=')) from = a.slice('--from='.length);
    }
    if (!mock && !from) mock = true; // default
    return { mock, from };
}

async function main() {
    const { mock, from } = parseArgs();
    const seedPath = from
        ? path.resolve(process.cwd(), from)
        : path.resolve(__dirname, 'team.sample.json');

    if (!fs.existsSync(seedPath)) {
        console.error(`[seed] File not found: ${seedPath}`);
        process.exit(1);
    }

    const raw: Array<Omit<TeamMemberFields, 'ConversationRef' | 'LastSeenUtc'>> =
        JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

    console.log(`[seed] Source: ${mock ? 'mock' : 'file'} (${seedPath})`);
    console.log(`[seed] Rows to seed: ${raw.length}`);

    // Try to resolve the current signed-in user via Graph /me and use that AAD id
    // for any row whose AadObjectId matches a placeholder OR whose Email matches
    // the signed-in user's UPN. Zero-friction for the "Mario is both SM and demo
    // user" scenario.
    const me = await tryResolveCurrentUserAad();
    if (me) {
        console.log(`[seed] Signed-in user resolved: aadId=${me.id} email=${me.mail}`);
        for (const row of raw) {
            const isPlaceholder = row.AadObjectId === 'REPLACE_WITH_REAL_AAD_ID' || /^0{8}-/.test(row.AadObjectId);
            const isSameEmail = me.mail && row.Email && row.Email.toLowerCase() === me.mail;
            if (isPlaceholder || isSameEmail) {
                console.log(`[seed]   patching ${row.Title} AadObjectId -> ${me.id}`);
                row.AadObjectId = me.id;
            }
        }
    } else {
        console.log('[seed] No Graph token available — rows with placeholder AAD ids will be inserted as-is.');
        console.log('[seed] Run `npm run setup:sharepoint` first if you want auto-resolve.');
    }

    for (const row of raw) {
        const existing = await findByField<TeamMemberFields>(
            'teamMembers',
            'AadObjectId',
            row.AadObjectId,
        );
        if (existing.length > 0) {
            await updateItem<TeamMemberFields>('teamMembers', existing[0].id, {
                Title: row.Title,
                Email: row.Email,
                JiraAccountId: row.JiraAccountId,
                TimeZone: row.TimeZone,
                Role: row.Role,
            });
            console.log(`[seed] Updated ${row.Title}`);
        } else {
            await createItem<TeamMemberFields>('teamMembers', {
                Title: row.Title,
                Email: row.Email,
                AadObjectId: row.AadObjectId,
                JiraAccountId: row.JiraAccountId,
                TimeZone: row.TimeZone,
                Role: row.Role,
            });
            console.log(`[seed] Created ${row.Title}`);
        }
    }

    console.log('[seed] Done.');
}

main().catch(err => {
    console.error('[seed] Failed:', err?.message ?? err);
    process.exit(1);
});
