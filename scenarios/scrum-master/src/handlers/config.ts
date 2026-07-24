// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * `/config channel` command handler.
 *
 * Run by the Scrum Master from inside the Teams channel where the agent
 * should post summaries, warnings, and sprint reports. Captures the
 * ConversationReference for that channel and stores it in the TeamsConfig
 * SharePoint list so the agent can post proactively later.
 */

import { TurnContext } from '@microsoft/agents-hosting';
import {
    ConversationReference,
    Activity,
} from '@microsoft/agents-activity';

import { findByField, createItem, updateItem } from '../services/sharepoint';

const PRIMARY = 'primary';

interface TeamsConfigFields {
    Title: string;
    TeamId: string;
    ChannelId: string;
    ConversationRef: string;
    ConfiguredByAadId: string;
    ConfiguredAtUtc: string;
}

export async function handleConfigChannel(context: TurnContext): Promise<void> {
    const activity: Activity = context.activity;

    // Teams populates `channelData` with team + channel identifiers for channel messages.
    const channelData = (activity.channelData ?? {}) as {
        team?: { id?: string };
        channel?: { id?: string };
    };
    const teamId = channelData.team?.id ?? '';
    const channelId = channelData.channel?.id ?? '';

    if (!teamId || !channelId) {
        await context.sendActivity(
            'This command must be run from **inside** the Teams channel where I should post updates. ' +
            'Please @mention me from the channel and try again.',
        );
        return;
    }

    const convRef: Partial<ConversationReference> = activity.getConversationReference();

    // Normalize the reference so proactive sends produce a NEW top-level channel
    // post instead of a reply inside the thread where `/config channel` was typed:
    //   - Teams encodes the thread anchor as `conversation.id = "19:<channelId>@thread.tacv2;messageid=<parentMessageId>"`.
    //     Stripping the `;messageid=...` tail collapses that to the channel root.
    //   - `activityId` also pins the reply to a specific message. We drop it.
    //   - We also force `conversation.id` to the channel id from channelData so
    //     even if Teams changes its encoding, the destination stays correct.
    if (convRef.conversation) {
        convRef.conversation.id = channelId;
    }
    delete (convRef as { activityId?: string }).activityId;

    const convRefJson = JSON.stringify(convRef);
    const fields = {
        Title: PRIMARY,
        TeamId: teamId,
        ChannelId: channelId,
        ConversationRef: convRefJson,
        ConfiguredByAadId: activity.from?.aadObjectId ?? '',
        ConfiguredAtUtc: new Date().toISOString(),
    };

    const existing = await findByField<TeamsConfigFields>('teamsConfig', 'Title', PRIMARY);
    if (existing.length > 0) {
        await updateItem<TeamsConfigFields>('teamsConfig', existing[0].id, fields);
    } else {
        await createItem<TeamsConfigFields>('teamsConfig', fields);
    }

    await context.sendActivity(
        `Done — I'll post standup summaries, warnings, and sprint reports to this channel from now on.`,
    );
    console.log(`[config] Channel configured: team=${teamId} channel=${channelId}`);
}
