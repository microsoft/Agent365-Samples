// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adaptive Card factory for the blocker-escalation DM to the Scrum Master
 * (MVP 3 — Chase). Shown when a squad member flags a blocker in their standup.
 */

import { Attachment } from './standup-request.card';

export interface BlockerCardParams {
    blockerId: string;                // SharePoint list-item id of the Blocker row
    issueKey: string;
    summary: string;
    url: string;
    status: string;
    sprintName: string;
    ownerDisplayName: string;
    reporterDisplayName: string;
    blockerText: string;
}

export function buildBlockerEscalationCard(p: BlockerCardParams): Attachment {
    return {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.5',
            body: [
                { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: `🚧 Blocker: ${p.issueKey}` },
                { type: 'TextBlock', wrap: true, text: p.summary },
                {
                    type: 'FactSet',
                    facts: [
                        { title: 'Owner', value: p.ownerDisplayName },
                        { title: 'Reporter', value: p.reporterDisplayName },
                        { title: 'Status', value: p.status },
                        { title: 'Sprint', value: p.sprintName },
                    ],
                },
                {
                    type: 'TextBlock', wrap: true, spacing: 'Small',
                    text: `**What's blocking:** ${p.blockerText || '_(no detail provided)_'}`,
                },
            ],
            actions: [
                {
                    type: 'Action.Submit',
                    title: 'Propose unblock meeting',
                    style: 'positive',
                    data: { action: 'blocker.proposeSlots', issueKey: p.issueKey, blockerId: p.blockerId },
                },
                {
                    type: 'Action.OpenUrl',
                    title: 'Open in Jira',
                    url: p.url,
                },
                {
                    type: 'Action.Submit',
                    title: 'Dismiss',
                    data: { action: 'blocker.dismiss', blockerId: p.blockerId },
                },
            ],
        },
    };
}
