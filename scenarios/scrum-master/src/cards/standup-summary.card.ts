// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adaptive Card factory for the consolidated standup summary posted to the
 * configured Teams channel.
 *
 * Format matches the client-approved template (AdaptiveCard_Standup_Summary_No_Colors.json):
 *   - Header: "🗓️ Sprint Standup Summary"
 *   - Subtitle: Sprint / Date / Responses (X/Y)
 *   - Table with 6 columns:  Owner | JIRA | Title | Status | Today's Updates | Blocker
 *   - One row per (person, issue) pair — Owner name repeats where a person owns
 *     multiple issues.
 *   - "Task-N" is the friendly display form of the Jira key (`EDP-14` -> `Task-14`).
 *   - Blocker text (if any) appears inline in the last column, so the card is a
 *     single self-contained artefact — no separate "Blockers" section.
 *   - Delivery splits oversized summaries into numbered cards at a measured
 *     90,000-byte activity budget; exceptionally large cells continue in rows.
 */

import { Attachment } from './standup-request.card';

// Leave headroom below Teams' 100 KB limit for connector-added metadata.
export const STANDUP_ACTIVITY_BYTE_BUDGET = 90_000;

/** Split the rendered card, measuring the complete outgoing UTF-8 activity.
 * Ordinary summaries are unchanged. Oversized individual cells continue in
 * subsequent rows (without repeating other cells), preserving every code point.
 */
export function splitStandupSummaryActivity(activity: any): any[] {
    const bytes = (value: any) => Buffer.byteLength(
        typeof value.toJsonString === 'function' ? value.toJsonString() : JSON.stringify(value), 'utf8');
    if (bytes(activity) <= STANDUP_ACTIVITY_BYTE_BUDGET) return [activity];

    const attachment = activity.attachments[0];
    const card = attachment.content;
    const units = card.body.flatMap((element: any) => element.type === 'Table'
        ? element.rows.slice(1).map((row: any) => ({ ...element, rows: [element.rows[0], row] }))
        : [element]);
    const marker = {
        type: 'TextBlock', wrap: true, isSubtle: true,
        text: 'Standup summary — part 9999999999999999 of 9999999999999999',
    };
    const wrap = (elements: any[]) => {
        const body: any[] = [{ ...marker }];
        for (const element of elements) {
            const previous = body[body.length - 1];
            if (element.type === 'Table' && previous.type === 'Table') {
                previous.rows.push(...element.rows.slice(1));
            } else {
                body.push(element.type === 'Table' ? { ...element, rows: [...element.rows] } : element);
            }
        }
        const entities = card.msteams?.entities?.filter((entity: any) =>
            body.some(element => typeof element.text === 'string' && element.text.includes(entity.text)));
        const msteams = { ...card.msteams };
        if (entities?.length) msteams.entities = entities;
        else delete msteams.entities;
        return {
            ...activity,
            attachments: [{ ...attachment, content: { ...card, body, msteams } }],
        };
    };
    const splitUnit = (unit: any): any[] => {
        if (typeof unit.text === 'string'
            && card.msteams?.entities?.some((entity: any) => unit.text.includes(entity.text))) {
            throw new Error('Standup summary mention exceeds the Teams byte budget.');
        }
        const first = JSON.parse(JSON.stringify(unit));
        const second = JSON.parse(JSON.stringify(unit));
        const texts = (value: any): any[] => value.type === 'Table'
            ? value.rows[1].cells.flatMap((c: any) => c.items.filter((i: any) => typeof i.text === 'string'))
            : typeof value.text === 'string' ? [value] : [];
        const left = texts(first);
        const right = texts(second);
        let longest = -1;
        for (let i = 0; i < left.length; i++) {
            if (longest < 0 || left[i].text.length > left[longest].text.length) longest = i;
        }
        if (longest < 0) throw new Error('Standup summary activity envelope exceeds the Teams byte budget.');
        const points = Array.from(left[longest].text as string);
        if (points.length < 2) throw new Error('Standup summary activity envelope exceeds the Teams byte budget.');
        const mid = Math.floor(points.length / 2);
        left[longest].text = points.slice(0, mid).join('');
        right.forEach((value, i) => { value.text = i === longest ? points.slice(mid).join('') : ''; });
        return [first, second];
    };
    const parts: any[] = [];
    let current: any[] = [];
    const pending = [...units];
    while (pending.length) {
        const unit = pending.shift()!;
        if (bytes(wrap([...current, unit])) <= STANDUP_ACTIVITY_BYTE_BUDGET) {
            current.push(unit);
        } else if (current.length) {
            parts.push(wrap(current));
            current = [];
            pending.unshift(unit);
        } else {
            // An envelope that cannot carry even an empty card cannot be fixed
            // by splitting response text; fail before sending any part.
            if (bytes(wrap([])) > STANDUP_ACTIVITY_BYTE_BUDGET) {
                throw new Error('Standup summary activity envelope exceeds the Teams byte budget.');
            }
            pending.unshift(...splitUnit(unit));
        }
    }
    if (current.length) parts.push(wrap(current));
    parts.forEach((part, i) => {
        part.attachments[0].content.body[0].text = `Standup summary — part ${i + 1} of ${parts.length}`;
        if (bytes(part) > STANDUP_ACTIVITY_BYTE_BUDGET) throw new Error('Standup summary exceeds the Teams byte budget.');
    });
    return parts;
}

export interface StandupSummaryUpdateItem {
    issueKey: string;
    url: string;
    /** Cleaned issue summary — "User Story: X" / "Task N: [Cat]: Y" prefixes stripped. */
    title: string;
    statusFrom: string;
    statusTo?: string | null;
    update: string;
    /** Undefined means unblocked; an empty string means blocked without details. */
    blockerText?: string;
}

export interface StandupSummaryPerson {
    displayName: string;
    items: StandupSummaryUpdateItem[];
}

export interface StandupSummaryMissed {
    displayName: string;
    neverInstalled: boolean;
}

/** Kept for callers still passing this in; the new card no longer uses it as a separate section. */
export interface StandupSummaryBlocker {
    issueKey: string;
    url: string;
    ownerDisplayName: string;
    blockerText: string;
}

export interface StandupSummaryParams {
    sprintName: string;
    dateLocal: string;
    respondedCount: number;
    expectedCount: number;
    updatesByPerson: StandupSummaryPerson[];
    missed: StandupSummaryMissed[];
    blockers: StandupSummaryBlocker[];   // still accepted for backward compat; not used here
    scrumMaster?: { aadId: string; displayName: string } | null;
}

/** "EDP-14" -> "Task-14". Only rewrites the project prefix; number is preserved. */
function toTaskLabel(issueKey: string): string {
    const m = issueKey.match(/^[A-Z][A-Z0-9]*-(\d+)$/);
    return m ? `Task-${m[1]}` : issueKey;
}

function statusCellText(item: StandupSummaryUpdateItem): string {
    if (item.statusTo && item.statusTo !== item.statusFrom) return item.statusTo;
    return item.statusFrom;
}

function cell(text: string, opts?: { bold?: boolean; wrap?: boolean }) {
    const tb: any = { type: 'TextBlock', text, wrap: opts?.wrap ?? true };
    if (opts?.bold) tb.weight = 'Bolder';
    return { type: 'TableCell', items: [tb] };
}

// The 6-column layout — proportions tuned so wide "Today's Updates" and
// "Blocker" columns have room to wrap, while narrow keys / status stay
// compact. Effective widths kick in only when msteams.width = "Full" on
// the card (see buildStandupSummaryCard below), otherwise Teams squeezes
// everything into a narrow chat bubble.
const COLUMNS = [
    { width: 3 },      // Owner — bumped so a two-word display name (e.g. "Alex Rivera") fits on one line
    { width: 2 },      // JIRA key (as "Task-XX") — bumped so "Task-6" fits on one line
    { width: 3 },      // Title
    { width: 3 },      // Status — bumped so "In Progress" / "In Review" fit
    { width: 5 },      // Today's Updates
    { width: 4 },      // Blocker
];

const HEADER_ROW = {
    type: 'TableRow',
    cells: [
        cell('Owner', { bold: true }),
        cell('JIRA', { bold: true }),
        cell('Title', { bold: true }),
        cell('Status', { bold: true }),
        cell("Today's Updates", { bold: true }),
        cell('Blocker', { bold: true }),
    ],
};

export function buildStandupSummaryCard(p: StandupSummaryParams): Attachment {
    // Flatten (person, item) pairs into table rows.
    const rows: any[] = [HEADER_ROW];
    for (const person of p.updatesByPerson) {
        for (const item of person.items) {
            const jiraDisplay = toTaskLabel(item.issueKey);
            const jiraLinked = item.url ? `[${jiraDisplay}](${item.url})` : jiraDisplay;
            rows.push({
                type: 'TableRow',
                cells: [
                    cell(person.displayName),
                    cell(jiraLinked),
                    cell(item.title || '(no title)'),
                    cell(statusCellText(item)),
                    cell(item.update),
                    cell(item.blockerText === undefined ? '' : item.blockerText.trim() || 'Blocked (no details provided)'),
                ],
            });
        }
    }

    // "Missed" responders (if any) go as a small footer note so the card stays
    // single-artefact, matching the client template.
    const missedFooter = p.missed.length > 0
        ? [{
            type: 'TextBlock',
            spacing: 'Medium', separator: true, wrap: true, isSubtle: true,
            text: `**Missed:** ${p.missed.map(m => m.displayName + (m.neverInstalled ? ' _(no agent DM yet)_' : '')).join(', ')}`,
        }]
        : [];

    const smMentionTag = p.scrumMaster ? `<at>${p.scrumMaster.displayName}</at>` : '';
    const smBlockerNote = p.scrumMaster && rows.some((r, i) => i > 0 && String(r.cells?.[5]?.items?.[0]?.text ?? '').length > 0)
        ? [{
            type: 'TextBlock',
            spacing: 'Small', wrap: true, isSubtle: true,
            text: `_${smMentionTag} — see blockers listed above._`,
        }]
        : [];

    const body: any[] = [
        { type: 'TextBlock', text: '🗓️ Sprint Standup Summary', weight: 'Bolder', size: 'Large' },
        {
            type: 'TextBlock',
            text: `**Sprint:** ${p.sprintName}\n**Date:** ${p.dateLocal}\n**Responses:** ${p.respondedCount}/${p.expectedCount}`,
            wrap: true, spacing: 'Small',
        },
        rows.length > 1
            ? { type: 'Table', firstRowAsHeaders: true, showGridLines: true, columns: COLUMNS, rows }
            : { type: 'TextBlock', isSubtle: true, wrap: true, text: '_No updates received._' },
        ...missedFooter,
        ...smBlockerNote,
    ];

    const card: any = {
        $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.5',
        body,
        // Render at channel full-width instead of the default narrow chat-bubble.
        // Without this, the six-column table gets squeezed to unreadable widths
        // (headers like "Owner" wrap letter-by-letter vertically).
        msteams: { width: 'Full' } as any,
    };

    if (p.scrumMaster && smBlockerNote.length > 0) {
        card.msteams = {
            ...card.msteams,
            entities: [{
                type: 'mention',
                text: smMentionTag,
                mentioned: { id: p.scrumMaster.aadId, name: p.scrumMaster.displayName },
            }],
        };
    }

    return {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: card,
    };
}
