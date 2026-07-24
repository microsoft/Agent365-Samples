// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adaptive Card factory for the "confirm risky transitions" DM to the SM
 * (MVP 2 — Reconcile). Only shown when the reconciler couldn't safely
 * auto-apply a transition (backwards move, skip step, ambiguous mapping).
 */

import { Attachment } from './standup-request.card';

export interface ProposedTransition {
    issueKey: string;
    url: string;
    summary: string;
    statusFrom: string;
    statusTo: string;
    transitionId: string;
    reason: string;               // human-readable rationale
}

export interface TransitionConfirmCardParams {
    standupId: string;
    sprintName: string;
    autoAppliedCount: number;
    transitions: ProposedTransition[];
}

export function buildTransitionConfirmCard(p: TransitionConfirmCardParams): Attachment {
    const rows = p.transitions.map(t => ({
        type: 'Container',
        separator: true,
        items: [
            {
                type: 'TextBlock', wrap: true, weight: 'Bolder',
                text: `[${t.issueKey}](${t.url}) — ${t.summary}`
            },
            {
                type: 'TextBlock', wrap: true,
                text: `**${t.statusFrom} → ${t.statusTo}** (${t.reason})`
            },
            {
                type: 'Input.Toggle',
                id: `approve_${t.issueKey}`,
                title: 'Approve this change',
                value: 'true',
                valueOn: 'true', valueOff: 'false',
            },
        ],
    }));

    return {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.5',
            body: [
                {
                    type: 'TextBlock', size: 'Medium', weight: 'Bolder',
                    text: `Review board changes for Sprint ${p.sprintName}`
                },
                {
                    type: 'TextBlock', wrap: true, isSubtle: true,
                    text: `I applied ${p.autoAppliedCount} straightforward status change${p.autoAppliedCount === 1 ? '' : 's'}. The ones below need your call.`
                },
                ...rows,
            ],
            actions: [
                {
                    type: 'Action.Submit', title: 'Apply approved', style: 'positive',
                    data: {
                        action: 'reconcile.apply',
                        standupId: p.standupId,
                        // The submit will carry the toggle values; we serialize the transitions
                        // for lookup on the server so the SM can't be spoofed into transitioning
                        // arbitrary issues.
                        transitions: JSON.stringify(p.transitions),
                    },
                },
                {
                    type: 'Action.Submit', title: 'Skip all',
                    data: { action: 'reconcile.skipAll', standupId: p.standupId },
                },
            ],
        },
    };
}
