// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Adaptive Card factory for the standup DM sent to each squad member.
 *
 * We build the JSON in code (with real values already baked in) rather than
 * shipping a template file + template engine. It's less flexible than
 * Adaptive Card Templating but for 5 cards it's much simpler and works with
 * any Adaptive Card renderer without extra runtime.
 *
 * Returns a Bot Framework `Attachment` ready to slot into
 * `context.sendActivity({ attachments: [card] })`.
 */

import { Activity } from '@microsoft/agents-activity';
import { JiraIssue } from '../services/jira';

export type Attachment = NonNullable<Activity['attachments']>[number];

export interface StandupCardParams {
    standupId: string;
    sprintName: string;
    cutoffLocal: string;                    // pre-formatted human string, e.g. "1:00 PM IST"
    assigneeAadId: string;
    items: JiraIssue[];
}

export function buildStandupRequestCard(p: StandupCardParams): Attachment {
    const itemContainers = p.items.map(issue => ({
        type: 'Container',
        separator: true,
        items: [
            {
                type: 'ColumnSet',
                columns: [
                    {
                        type: 'Column', width: 'auto',
                        items: [{ type: 'TextBlock', weight: 'Bolder', color: 'Accent', text: issue.key }],
                    },
                    {
                        type: 'Column', width: 'stretch',
                        items: [
                            { type: 'TextBlock', wrap: true, text: issue.summary },
                            {
                                type: 'TextBlock', spacing: 'None', isSubtle: true,
                                text: `Status: ${issue.status}${issue.storyPoints != null ? ` · ${issue.storyPoints} pts` : ''}`,
                            },
                        ],
                    },
                ],
            },
            {
                type: 'Input.Text',
                id: `update_${issue.key}`,
                isMultiline: true,
                placeholder: "What did you do / what's next?",
                isRequired: true,
                errorMessage: 'Please share an update.',
            },
            {
                type: 'Input.Toggle',
                id: `blocker_${issue.key}`,
                title: "I'm blocked on this",
                valueOn: 'true', valueOff: 'false', value: 'false',
            },
            {
                type: 'Input.Text',
                id: `blockerText_${issue.key}`,
                isMultiline: true,
                placeholder: 'Describe the blocker (who / what is needed)',
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
                    type: 'TextBlock',
                    size: 'Large', weight: 'Bolder',
                    text: `Standup — Sprint ${p.sprintName}`,
                },
                {
                    type: 'TextBlock',
                    wrap: true, isSubtle: true,
                    text: `Please share an update on each of your items. Reply by **${p.cutoffLocal}**.`,
                },
                ...itemContainers,
            ],
            actions: [
                {
                    type: 'Action.Submit',
                    title: 'Submit update',
                    style: 'positive',
                    data: {
                        action: 'standup.submit',
                        standupId: p.standupId,
                        assigneeAadId: p.assigneeAadId,
                    },
                },
            ],
        },
    };
}

/**
 * "Submitted" chrome — same visual shell as the request card, but with the user's
 * inputs baked in as read-only TextBlocks and a green footer. We send this as a
 * follow-up message on submit; card `refresh` semantics vary by channel so we keep
 * it simple with a fresh activity.
 */
export interface StandupSubmittedCardParams {
    sprintName: string;
    submittedAtLocal: string;
    items: Array<{ issueKey: string; update: string; hasBlocker: boolean; blockerText?: string }>;
}

export function buildStandupSubmittedCard(p: StandupSubmittedCardParams): Attachment {
    const itemBlocks = p.items.map(i => ({
        type: 'Container',
        separator: true,
        items: [
            { type: 'TextBlock', weight: 'Bolder', color: 'Accent', text: i.issueKey },
            { type: 'TextBlock', wrap: true, text: i.update },
            ...(i.hasBlocker
                ? [{
                    type: 'TextBlock', wrap: true, color: 'Attention',
                    text: `🚧 Blocker: ${i.blockerText ?? '(no detail provided)'}`,
                }]
                : []),
        ],
    }));

    return {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.5',
            body: [
                { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: `Standup — Sprint ${p.sprintName}` },
                { type: 'TextBlock', color: 'Good', text: `✓ Submitted at ${p.submittedAtLocal}` },
                ...itemBlocks,
            ],
        },
    };
}
