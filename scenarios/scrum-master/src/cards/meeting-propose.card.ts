// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adaptive Card factory for the meeting-slot proposal card (MVP 3 — Chase).
 * Shown to the SM after they tap "Propose unblock meeting" on the blocker card.
 */

import { Attachment } from './standup-request.card';

export interface SlotChoice {
    startIso: string;
    endIso: string;
    label: string;
}

export interface MeetingProposeCardParams {
    blockerId: string;
    issueKey: string;
    /** Display names of the people invited, in whatever order the caller wants
     *  them shown. This is deduplicated case-insensitively before rendering, so
     *  small teams where owner+reporter+SM are the same person don't render as
     *  "Alice, Alice, Alice". */
    attendeeNames: string[];
    durationMinutes: number;
    slots: SlotChoice[];
}

export function buildMeetingProposeCard(p: MeetingProposeCardParams): Attachment {
    const seen = new Set<string>();
    const distinct = p.attendeeNames.filter(n => {
        const key = (n ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const attendeesLine = distinct.length
        ? `Attendees: ${distinct.join(', ')} · ${p.durationMinutes} min`
        : `Duration: ${p.durationMinutes} min`;

    return {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.5',
            body: [
                {
                    type: 'TextBlock', size: 'Medium', weight: 'Bolder',
                    text: `Book unblock sync for ${p.issueKey}`
                },
                {
                    type: 'TextBlock', wrap: true,
                    text: attendeesLine,
                },
                {
                    type: 'Input.ChoiceSet',
                    id: 'slot',
                    style: 'expanded',
                    isRequired: true,
                    errorMessage: 'Pick a slot.',
                    choices: p.slots.map(s => ({
                        title: s.label,
                        value: `${s.startIso}|${s.endIso}`,
                    })),
                },
            ],
            actions: [
                {
                    type: 'Action.Submit', title: 'Book it', style: 'positive',
                    data: { action: 'meeting.book', blockerId: p.blockerId, issueKey: p.issueKey },
                },
                {
                    type: 'Action.Submit', title: 'Cancel',
                    data: { action: 'meeting.cancel', blockerId: p.blockerId },
                },
            ],
        },
    };
}
